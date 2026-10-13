import * as M from './model.js';
import { LinePlot, ImagePlot, COLORMAPS, si, fmt } from './plot.js';
import { SceneView, ArrayView, SkyView } from './views.js';
import { createPythonDialog } from './pydialog.js';
import { LAYOUT_EXAMPLES } from './layouts.js';
import { initTimeline } from './timeline.js';
import { initOutputs } from './outputs.js';
import { initTransmitter, readFringeCalibrators, fringeCalibratorJson, serializeCf32, newTransmitter } from './transmitter.js';

const $ = (id) => document.getElementById(id);
const MHz = (f) => `${+(f / 1e6).toFixed(3)} MHz`;
const DEG = 180 / Math.PI;

// ---------------------------------------------------------------------------------------
// State

/** Colours of calibrators by index (theme series tokens), repeating after the fourth. */
const CAL_COLORS = ['s3', 's4', 's5', 's6'];

/**
 * A calibrator: off, kinematic ('fixed': a state at the start epoch in the array frame, then
 * constant acceleration) or a series (one state per integration, see timeline.js), with its
 * fringe Transmitter settings and cyclic buffer (see transmitter.js). Names and colours follow the
 * calibrator's place in the list (renumberCalibrators).
 */
function newCalibrator(overrides = {}) {
  return {
    name: '', color: '', mode: 'off',
    position: { x: 62, y: 62, z: 150 }, velocity: { x: 0, y: 0, z: 0 }, acceleration: { x: 0, y: 0, z: 0 },
    transmitter: newTransmitter(),
    series: { rows: [], source: '', python: null, pythonPending: false, origin: 'centroid', doppler: true },
    ...overrides,
  };
}

const state = {
  array: M.defaultArray(),
  sources: [],
  calibrators: [newCalibrator()],
  // Index of the calibrator the sidebar edits.
  activeCal: 0,
  runtime: 'gpu',
  viewFreq: 30e6,
  cmap: 'plasma',
  // Latest run loaded from the server, plus the client-side snapshot it was started from.
  run: null,
  snapshot: null,
  runKey: null,
  activeRunId: null,
  antenna: 0,
  antennaData: null,
  channel: 0,
  rates: {}, // measured source·bin evaluations per second, per runtime
  gsmAvailable: false,
  skyOrigin: '',
  python: false,
  pythonDisabled: null,
};

// ---------------------------------------------------------------------------------------
// Utilities

function toast(message, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  $('toasts').appendChild(el);
  setTimeout(() => el.remove(), Math.min(16000, Math.max(kind === 'error' ? 9000 : 4500, message.length * 45)));
}

async function api(path, options) {
  const res = await fetch(`/api${path}`, options);
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try { msg = (await res.json()).error || msg; } catch { /* not JSON */ }
    throw new Error(msg);
  }
  return res.status === 204 ? null : res.json();
}

/** Saves text or binary data (an ArrayBuffer) as a file. */
function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function readFile(input) {
  return new Promise((resolve, reject) => {
    const file = input.files[0];
    if (!file) return reject(new Error('no file'));
    const r = new FileReader();
    r.onload = () => { input.value = ''; resolve(r.result); };
    r.onerror = () => reject(r.error);
    r.readAsText(file);
  });
}

function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

function tiles(el, items) {
  el.innerHTML = items.map(([k, v, s]) =>
    `<div class="tile"><div class="k">${k}</div><div class="v">${v}</div>${s ? `<div class="s">${s}</div>` : ''}</div>`).join('');
}

function median(values) {
  const v = Array.from(values).filter(Number.isFinite).sort((a, b) => a - b);
  return v.length ? v[v.length >> 1] : NaN;
}

// Worker for beams / expected images; each consumer only accepts its latest request.
const worker = new Worker('js/worker.js', { type: 'module' });
const pending = new Map();
let jobId = 0;
worker.onmessage = ({ data }) => {
  const p = pending.get(data.id);
  pending.delete(data.id);
  if (!p) return;
  data.error ? p.reject(new Error(data.error)) : p.resolve(data);
};
function compute(kind, args) {
  return new Promise((resolve, reject) => {
    const id = ++jobId;
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, kind, args });
  });
}

function relativeXY(positions) {
  const c = M.centroid(positions);
  const xs = new Float64Array(positions.length), ys = new Float64Array(positions.length);
  positions.forEach((p, i) => { xs[i] = p.x - c.x; ys[i] = p.y - c.y; });
  return { xs, ys };
}

function skyImageData(values, size) {
  return { values, cols: size, rows: size, x0: -1, x1: 1, y0: -1, y1: 1 };
}

function directionTip(p) {
  const r = Math.hypot(p.x, p.y);
  if (r > 1) return '';
  const el = Math.acos(Math.min(1, r)) * DEG;
  const az = ((Math.atan2(p.y, p.x) * DEG) + 360) % 360;
  return `<div class="tip-row">elevation<b>${el.toFixed(1)}°</b></div><div class="tip-row">azimuth from +x<b>${az.toFixed(1)}°</b></div>`;
}

// ---------------------------------------------------------------------------------------
// Validation (mirrors fringe's asserts so problems show before a run)

function validateArray(a) {
  if (!a.antenna_positions.length) return 'The array has no antennas.';
  if (!(a.sample_frequency > 0)) return 'Sample frequency must be positive.';
  if (!(a.downmix_frequency >= 0)) return 'Downmix frequency must be non-negative.';
  if (!(a.bandpass[0] > 0 && a.bandpass[0] < a.bandpass[1])) return 'Bandpass min must be positive and below max.';
  if (!(a.bandpass[1] <= a.sample_frequency / 2)) return `Bandpass max must be at most Nyquist (${MHz(a.sample_frequency / 2)}).`;
  if (!(a.system_noise_intensity >= 0)) return 'System noise must be non-negative.';
  return null;
}

// ---------------------------------------------------------------------------------------
// Views

const scene = new SceneView($('scene'));
const arrayView = new ArrayView($('array-view'));
const skyView = new SkyView($('sky-view'));
const beamView = new ImagePlot($('beam-view'), {
  sky: true, scale: 'log', dynamicRange: 30, xLabel: 'l', yLabel: 'm', cbLabel: 'relative power', empty: 'Computing…',
  hoverExtra: directionTip,
});
const modelPlot = new LinePlot($('model-spectrum'), {
  xLabel: 'frequency (MHz)', yLabel: 'power per bin (Jy)', yLog: true, yFloorRatio: 1e5, empty: 'No bandpass',
});
const powerMap = new ArrayView($('power-map'), { onSelect: (i) => selectAntenna(i) });
const tsPlot = new LinePlot($('timeseries'), { xLabel: 'time (µs)', yLabel: 'amplitude (√Jy)' });
const specPlot = new LinePlot($('spectrum'), { xLabel: 'frequency (MHz)', yLabel: 'power per bin (Jy)', yLog: true, yFloorRatio: 1e4 });
const histPlot = new LinePlot($('histogram'), { xLabel: 'sample value', yLabel: 'probability density', yZero: true });
const waterfall = new ImagePlot($('waterfall'), {
  scale: 'log', robust: true, xLabel: 'frequency (MHz)', yLabel: 'integration', cbLabel: 'power (dB)', yFormat: (v) => fmt(v, 3),
});
const imgOpts = { sky: true, xLabel: 'l', yLabel: 'm', cbLabel: 'apparent flux density (Jy)', hoverExtra: directionTip };
const dirtyImage = new ImagePlot($('dirty-image'), { ...imgOpts, empty: 'Loading…', overlay: (...a) => drawImageOverlay(...a) });
const expectedImage = new ImagePlot($('expected-image'), { ...imgOpts, empty: 'Computing…', overlay: (...a) => drawImageOverlay(...a) });
const psfImage = new ImagePlot($('psf-image'), { sky: true, scale: 'log', dynamicRange: 30, xLabel: 'Δl', yLabel: 'Δm', cbLabel: 'relative power', empty: 'Computing…' });
const allViews = [scene, arrayView, skyView, beamView, modelPlot, powerMap, tsPlot, specPlot, histPlot, waterfall, dirtyImage, expectedImage, psfImage];

// ---------------------------------------------------------------------------------------
// Sidebar: inputs <-> state

function populateSelects() {
  const ws = $('window-size');
  for (let p = 8; p <= 16; p++) ws.add(new Option(String(2 ** p), String(2 ** p)));
  for (const id of ['env-cmap', 'img-cmap']) for (const c of COLORMAPS) $(id).add(new Option(c, c));
  renderGenParams();
}

function writeArrayInputs() {
  const a = state.array;
  $('fs').value = a.sample_frequency / 1e6;
  $('fdown').value = a.downmix_frequency / 1e6;
  $('bp-min').value = a.bandpass[0] / 1e6;
  $('bp-max').value = a.bandpass[1] / 1e6;
  if (![...$('window-size').options].some((o) => +o.value === a.sample_window_size)) {
    $('window-size').add(new Option(String(a.sample_window_size), String(a.sample_window_size)));
  }
  $('window-size').value = String(a.sample_window_size);
  $('noise').value = a.system_noise_intensity;
  renderNoiseNote();
}

/** The system noise as a temperature (k_B·T_sys is given in Jy m²). */
function renderNoiseNote() {
  const t = state.array.system_noise_intensity / M.K_B_JY;
  $('noise-note').textContent = Number.isFinite(t) ? `T_sys = ${t >= 1e5 || t < 1 ? fmt(t, 3) : Math.round(t).toLocaleString()} K` : '';
}

function readArrayInputs() {
  const a = state.array;
  a.sample_frequency = parseFloat($('fs').value) * 1e6;
  a.downmix_frequency = parseFloat($('fdown').value) * 1e6;
  a.bandpass = [parseFloat($('bp-min').value) * 1e6, parseFloat($('bp-max').value) * 1e6];
  a.sample_window_size = parseInt($('window-size').value, 10);
  a.system_noise_intensity = parseFloat($('noise').value);
  renderNoiseNote();
  envChanged();
}

const KINEMATICS = [['position', 'cal-'], ['velocity', 'cal-v'], ['acceleration', 'cal-a']];

const activeCal = () => state.calibrators[state.activeCal];
const enabledCals = () => state.calibrators.filter((c) => c.mode !== 'off');

function renumberCalibrators() {
  state.calibrators.forEach((c, i) => { c.name = `C${i + 1}`; c.color = CAL_COLORS[i % CAL_COLORS.length]; });
}

function writeCalibratorInputs() {
  const c = activeCal();
  for (const [key, prefix] of KINEMATICS) for (const axis of 'xyz') $(`${prefix}${axis}`).value = +c[key][axis].toPrecision(12);
}

const calibratorChanged = debounce(() => timeline && timeline.refresh(), 120);

function readCalibratorInputs() {
  const c = activeCal();
  for (const [key, prefix] of KINEMATICS) {
    c[key] = Object.fromEntries([...'xyz'].map((axis) => [axis, parseFloat($(`${prefix}${axis}`).value) || 0]));
  }
  calibratorChanged();
  envChanged();
}

const MODE_NAMES = { off: 'off', fixed: 'kinematic', series: 'series' };

/** The calibrator chips, and the controls of the selected calibrator. */
function renderCalibratorPanel() {
  const cal = activeCal();
  const chips = state.calibrators.map((c, i) => {
    const b = document.createElement('button');
    b.className = `cal-chip${i === state.activeCal ? ' on' : ''}${c.mode === 'off' ? ' off' : ''}`;
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', String(i === state.activeCal));
    b.style.setProperty('--c', `var(--series-${c.color.slice(1)})`);
    b.innerHTML = `<span class="swatch"></span>${c.name} <span class="mode">${MODE_NAMES[c.mode]}</span>`;
    b.addEventListener('click', () => selectCalibrator(i));
    return b;
  });
  const add = Object.assign(document.createElement('button'), { className: 'cal-chip add', textContent: '+ Add', title: 'Add a calibrator' });
  add.addEventListener('click', addCalibrator);
  $('cal-list').replaceChildren(...chips, add);
  document.querySelectorAll('#cal-mode button').forEach((b) => b.classList.toggle('on', b.dataset.value === cal.mode));
  $('cal-fixed').hidden = cal.mode !== 'fixed';
  $('cal-series').hidden = cal.mode !== 'series';
  $('cal-common').hidden = cal.mode === 'off';
  $('cal-remove').disabled = state.calibrators.length < 2;
  $('cal-remove').textContent = `Remove ${cal.name}`;
  $('cal-skip-label').hidden = !enabledCals().length;
  writeCalibratorInputs();
  if (transmitter) transmitter.write();
  if (timeline) timeline.writeSeriesControls();
}

/** Calibrator off, kinematic (a state at the start epoch) or a series (one state per integration). */
function setCalMode(mode) {
  activeCal().mode = mode;
  renderCalibratorPanel();
  if (timeline) timeline.refresh();
  envChanged();
}

function selectCalibrator(i) {
  state.activeCal = Math.max(0, Math.min(state.calibrators.length - 1, i));
  renderCalibratorPanel();
  // The timeline's comparison frequency follows the selected calibrator.
  if (timeline) timeline.refresh();
}

/**
 * Adds a kinematic calibrator next to the array (a quarter turn round from the previous one) with
 * the selected calibrator's transmitter settings and its own noise buffer, and selects it.
 */
function addCalibrator() {
  const src = activeCal().transmitter;
  const c = M.centroid(state.array.antenna_positions);
  const angle = (Math.PI / 2) * (state.calibrators.length - 1);
  const pick = ({ frequency, sampleRate, power, bandwidth, startTime, length, degree }) => ({ frequency, sampleRate, power, bandwidth, startTime, length, degree });
  const seed = Math.max(...state.calibrators.map((k) => k.transmitter.seed || 0)) + 1;
  state.calibrators.push(newCalibrator({
    mode: 'fixed',
    position: { x: +(c.x + 60 * Math.cos(angle)).toFixed(2), y: +(c.y + 60 * Math.sin(angle)).toFixed(2), z: 150 },
    transmitter: newTransmitter({ ...pick(src), seed }),
  }));
  renumberCalibrators();
  selectCalibrator(state.calibrators.length - 1);
  envChanged();
}

function removeCalibrator() {
  if (state.calibrators.length < 2) return;
  state.calibrators.splice(state.activeCal, 1);
  renumberCalibrators();
  selectCalibrator(Math.min(state.activeCal, state.calibrators.length - 1));
  envChanged();
}

const GEN_PARAMS = {
  grid: [['nx', 'Columns', 32], ['ny', 'Rows', 32], ['spacing', 'Spacing (m)', 4]],
  random: [['n', 'Antennas', 256], ['radius', 'Radius (m)', 60], ['seed', 'Seed', 1]],
  ring: [['n', 'Antennas', 64], ['radius', 'Radius (m)', 50]],
};

function renderGenParams() {
  const kind = $('gen-layout').value;
  $('gen-params').innerHTML = GEN_PARAMS[kind]
    .map(([k, label, v]) => `<div class="field"><label for="gen-${k}">${label}</label><input id="gen-${k}" type="number" value="${v}" step="any"></div>`)
    .join('');
}

function generateArray() {
  const kind = $('gen-layout').value;
  const v = (k) => parseFloat($(`gen-${k}`).value);
  let positions;
  if (kind === 'grid') positions = M.gridArray(Math.max(1, v('nx') | 0), Math.max(1, v('ny') | 0), v('spacing'));
  else if (kind === 'random') positions = M.randomArray(Math.max(1, v('n') | 0), v('radius'), v('seed') | 0);
  else positions = M.ringArray(Math.max(1, v('n') | 0), v('radius'));
  state.array.antenna_positions = positions;
  state.antenna = 0;
  envChanged();
}

function resetArray() {
  state.array = M.defaultArray();
  state.antenna = 0;
  writeArrayInputs();
  envChanged();
}

/** Replaces the sky model and records where it came from (shown under the sky buttons). */
function setSky(sources, origin) {
  state.sources = sources;
  state.skyOrigin = origin;
  envChanged();
}

/** Marks the current sky as edited by hand. */
function editedOrigin() {
  const o = state.skyOrigin.replace(/ \(edited\)$/, '');
  return o ? `${o} (edited)` : 'Edited by hand';
}

/** Loads the bundled default sky: GSM2016 on the lunar far side, generated by scripts/gsm_sky.py. */
async function loadDefaultSky() {
  const [csv, meta] = await Promise.all([
    // Always revalidate: a hard reload does not cover fetches, so a copy cached before the server
    // sent Cache-Control could otherwise outlive a regenerated sky.
    fetch('data/default_sky.csv', { cache: 'no-cache' }).then((r) => { if (!r.ok) throw new Error('default sky model unavailable'); return r.text(); }),
    fetch('data/default_sky.json', { cache: 'no-cache' }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
  ]);
  const epoch = meta && meta.epoch_utc ? ` at ${meta.epoch_utc.replace('T', ' ').replace(/:00(\.000)?$/, '')} UTC` : '';
  setSky(M.parseSourcesCsv(csv), meta
    ? `Default: GSM2016, NSIDE ${meta.nside}, lunar far side${epoch}, ${gsmFitText({ order: meta.spectral_order || 1 })} fitted over ${meta.map_frequencies.length} maps`
    : 'Default sky model');
}

/**
 * Circular orbit state about a body whose centre is `depth` below the array centroid `c`: the
 * position at elevation `el` and azimuth `az` (from +y towards +x), `altitude` above the surface,
 * moving horizontally towards azimuth `heading`, with its centripetal acceleration.
 */
function orbitState(c, { radius, gm, altitude, el, az, heading }) {
  const centre = [c.x, c.y, c.z - radius];
  const r = radius + altitude;
  // Range from the array along (el, az) to the sphere of radius r about the centre.
  const u = [Math.cos(el) * Math.sin(az), Math.cos(el) * Math.cos(az), Math.sin(el)];
  const range = -radius * u[2] + Math.sqrt((radius * u[2]) ** 2 + r * r - radius * radius);
  const p = [c.x + range * u[0], c.y + range * u[1], c.z + range * u[2]];
  const rad = p.map((v, i) => (v - centre[i]) / r);
  // Horizontal direction of motion at the satellite: the heading projected onto its local horizon.
  const h = [Math.sin(heading), Math.cos(heading), 0];
  const along = h.map((v, i) => v - (h[0] * rad[0] + h[1] * rad[1] + h[2] * rad[2]) * rad[i]);
  const norm = Math.hypot(...along);
  const speed = Math.sqrt(gm / r), g = gm / (r * r);
  const round = (v, d) => +v.toFixed(d);
  const vec = (a, d) => ({ x: round(a[0], d), y: round(a[1], d), z: round(a[2], d) });
  return {
    position: vec(p, 1),
    velocity: vec(along.map((v) => (speed * v) / norm), 2),
    acceleration: vec(rad.map((v) => -g * v), 4),
  };
}

async function setCalibratorPreset(kind) {
  const c = M.centroid(state.array.antenna_positions);
  const zero = { x: 0, y: 0, z: 0 };
  let s;
  if (kind === 'drone') s = { position: { x: +c.x.toFixed(2), y: +c.y.toFixed(2), z: 150 }, velocity: zero, acceleration: zero };
  else if (kind === 'lunar') s = orbitState(c, { radius: 1737.4e3, gm: 4.9028e12, altitude: 100e3, el: Math.PI / 2, az: 0, heading: 30 / DEG });
  else s = orbitState(c, { radius: 6371e3, gm: 3.986004e14, altitude: 550e3, el: 30 / DEG, az: 30 / DEG, heading: 210 / DEG });
  const cal = activeCal();
  Object.assign(cal, s);
  setCalMode('fixed');
  await timeline.refresh();
  timeline.autoPower(cal);
}

function renderSourceList() {
  const f = state.viewFreq;
  const top = state.sources
    .map((s) => ({ s, v: M.sourceIntensity(s, f) * M.sourceGain(s) }))
    .sort((a, b) => b.v - a.v)
    .slice(0, 6);
  const el = $('source-list');
  if (!top.length) { el.innerHTML = '<p class="note">No sources. The simulation will contain system noise (and any calibrators) only.</p>'; return; }
  // Higher-order columns only when the sky has curved spectra, so they do not come and go with the view frequency.
  const curved = state.sources.some(M.isCurved);
  const idx = (v) => `<td>${(Math.abs(v || 0) < 0.005 ? 0 : v).toFixed(2)}</td>`; // no "-0.00"
  el.innerHTML = `<div class="head">Brightest (apparent at ${MHz(f)})</div>
    <table class="${curved ? 'curved' : ''}"><tr><th>RA°</th><th>Dec°</th><th title="Apparent flux density G·S(f)">Jy</th>` +
    (curved
      ? '<th title="First-order (power-law) spectral index">α₁</th><th title="Second-order spectral index (curvature)">α₂</th><th title="Third-order spectral index">α₃</th>'
      : '<th title="Spectral index">α</th>') +
    `<th></th></tr>
    ${top.map(({ s, v }, i) => `<tr><td>${(s.ra * DEG).toFixed(1)}</td><td>${(s.dec * DEG).toFixed(1)}</td><td>${fmt(v, 3)}</td>` +
      idx(s.alpha) + (curved ? idx(s.alpha2) + idx(s.alpha3) : '') +
      `<td><button class="rm" data-i="${i}" title="Remove source" aria-label="Remove source">×</button></td></tr>`).join('')}
    </table>`;
  el.querySelectorAll('.rm').forEach((b) => b.addEventListener('click', () => {
    const target = top[+b.dataset.i].s;
    setSky(state.sources.filter((s) => s !== target), editedOrigin());
  }));
}

// ---------------------------------------------------------------------------------------
// Python array layouts (run server-side with the user's Python; dialog in pydialog.js)

let pythonDialog = null;

const layoutKind = {
  title: 'Python array layout',
  fn: 'layout',
  what: 'antennas',
  applyLabel: 'Apply to array',
  storageKey: 'fringe.layoutCode',
  examples: LAYOUT_EXAMPLES,
  context() {
    const a = state.array;
    const [fmin, fmax] = M.physicalBand(a);
    return {
      sample_frequency: a.sample_frequency,
      downmix_frequency: a.downmix_frequency,
      bandpass: a.bandpass,
      fmin,
      fmax,
      sample_window_size: a.sample_window_size,
      positions: a.antenna_positions.map((p) => [p.x, p.y, p.z]),
    };
  },
  mountPreview(el) {
    el.innerHTML = '<div class="viz square"></div><div class="py-stats"></div>';
    const view = new ArrayView(el.firstChild);
    allViews.push(view);
    const stats = el.lastChild;
    return {
      /** The layout() result, or the current array when there is none. */
      show(result) {
        const positions = result ? result.positions : state.array.antenna_positions;
        view.set({ positions, calibrators: [] });
        const s = M.arrayStats(positions);
        const [, fmax] = M.physicalBand(state.array);
        const halfLambda = M.C / fmax / 2;
        const rows = [
          ['Showing', result ? 'layout() result' : 'current array'],
          ['Antennas', `${s.n.toLocaleString()}${result ? ` (current: ${state.array.antenna_positions.length.toLocaleString()})` : ''}`],
          ['Extent', `${si(s.maxX - s.minX, 3, 'm')} × ${si(s.maxY - s.minY, 3, 'm')}`],
          ['Longest baseline', si(s.maxBaseline, 4, 'm')],
        ];
        if (Number.isFinite(s.minSpacing)) {
          if (s.minSpacing === 0) rows.push(['Min. spacing', 'coincident antennas', 'warn']);
          else if (s.minSpacing > halfLambda) rows.push(['Min. spacing', `${si(s.minSpacing, 3, 'm')} · grating lobes above ${MHz(M.C / (2 * s.minSpacing))}`, 'warn']);
          else rows.push(['Min. spacing', `${si(s.minSpacing, 3, 'm')} (≤ λ_min/2 = ${si(halfLambda, 3, 'm')})`]);
        }
        rows.push(['Geometry', s.planar ? 'planar' : `non-planar (Δz ${si(s.maxZ - s.minZ, 3, 'm')})`]);
        stats.innerHTML = `<dl>${rows.map(([k, v, cls]) => `<dt>${k}</dt><dd class="${cls || ''}">${v}</dd>`).join('')}</dl>`;
      },
    };
  },
  apply(result) {
    state.array.antenna_positions = result.positions;
    state.antenna = 0;
    envChanged();
    toast(`Array layout set from Python: ${result.positions.length.toLocaleString()} antennas`, 'ok');
  },
};

function openPythonDialog(kind) {
  if (!pythonDialog) {
    pythonDialog = createPythonDialog(
      { api, available: () => ({ ok: state.python, reason: state.pythonDisabled }) },
      { layout: layoutKind, calibrator: timeline.pythonKind, transmitter: transmitter.pythonKind },
    );
  }
  pythonDialog.open(kind);
}

// ---------------------------------------------------------------------------------------
// GSM2016 sky models (generated server-side with PyGDSM)

function gsmParams() {
  const [lo, hi] = M.physicalBand(state.array);
  const mhz = (id) => parseFloat($(id).value) * 1e6;
  return {
    nside: parseInt($('gsm-nside').value, 10),
    maps: parseInt($('gsm-maps').value, 10),
    order: parseInt($('gsm-order').value, 10),
    fmin: mhz('gsm-fmin') || Math.max(10e6, lo),
    fmax: mhz('gsm-fmax') || hi,
    frame: $('gsm-frame').value,
    epoch: gsmEpoch(),
    resolution: $('gsm-resolution').value,
    above_horizon: $('gsm-horizon').checked,
  };
}

/** The spectrum a GSM fit uses: a power law or a log-polynomial of the given order. */
function gsmFitText({ order }) {
  return order > 1 ? `log-polynomial spectrum (to ${order === 2 ? '2nd' : '3rd'} order)` : 'power law';
}

/** The epoch input as an ISO 8601 UTC string with seconds (datetime-local may omit them). */
function gsmEpoch() {
  const v = $('gsm-epoch').value;
  return v.length === 16 ? `${v}:00` : v || null;
}

const GSM_FRAME_NOTES = {
  'lunar-farside': 'Frame: observer on the lunar far-side equator — x = east, y = north (lunar spin axis), z = zenith, so Dec is elevation. The zenith sweeps the ecliptic once per sidereal month.',
  equatorial: 'Frame: ICRS — fringe\'s zenith is the north celestial pole.',
  galactic: 'Frame: galactic — fringe\'s zenith is the north galactic pole.',
};

function renderGsmNote() {
  const lunar = $('gsm-frame').value === 'lunar-farside';
  $('gsm-epoch').disabled = !lunar;
  const [lo, hi] = M.physicalBand(state.array);
  $('gsm-fmin').placeholder = `${+(Math.max(10e6, lo) / 1e6).toFixed(3)}`;
  $('gsm-fmax').placeholder = `${+(hi / 1e6).toFixed(3)}`;
  const p = gsmParams();
  const pixels = 12 * p.nside * p.nside;
  const count = p.above_horizon ? Math.round(pixels / 2) : pixels;
  const freqs = Array.from({ length: Math.max(0, p.maps) }, (_, i) => p.fmin + (i * (p.fmax - p.fmin)) / Math.max(1, p.maps - 1));
  const shown = freqs.length > 6 ? [...freqs.slice(0, 3), null, ...freqs.slice(-2)] : freqs;
  const pixDeg = Math.sqrt((4 * Math.PI) / pixels) * DEG;
  const el = $('gsm-note');
  el.textContent =
    `≈ ${count.toLocaleString()} sources (pixel ≈ ${pixDeg.toFixed(2)}°) · maps at ${shown.map((f) => (f === null ? '…' : +(f / 1e6).toFixed(2))).join(', ')} MHz · ` +
    `MJy/sr × pixel solid angle → Jy per source, ${gsmFitText({ order: Math.max(1, Math.min(p.order, p.maps - 1)) })}` +
    `${p.order >= p.maps && p.maps >= 2 ? ` (${p.maps} maps fit no higher order)` : ''} fitted per pixel around the geometric-mean frequency. ` +
    GSM_FRAME_NOTES[p.frame];
  let problem = null;
  if (!(p.maps >= 2)) problem = 'At least two maps are needed to fit a spectral index.';
  else if (!(p.fmin >= 10e6)) problem = 'GSM2016 is only defined above 10 MHz.';
  else if (!(p.fmax > p.fmin)) problem = 'Fit max must exceed fit min.';
  else if (lunar && !p.epoch) problem = 'The lunar far-side frame needs an epoch.';
  else if (count > 100000) problem = `${count.toLocaleString()} sources will make simulations and the views slow.`;
  el.classList.toggle('warn', !!problem);
  if (problem) el.textContent = `${problem} ${el.textContent}`;
  const blocked = !state.gsmAvailable || (problem && !problem.includes('slow'));
  $('gsm-replace').disabled = $('gsm-append').disabled = !!blocked || generateGsm.busy;
}

async function generateGsm(append) {
  const params = gsmParams();
  generateGsm.busy = true;
  const button = append ? $('gsm-append') : $('gsm-replace');
  const label = button.textContent;
  button.textContent = 'Generating…';
  renderGsmNote();
  try {
    const { csv, summary } = await api('/sky/gsm', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params),
    });
    const sky = M.parseSourcesCsv(csv);
    const what = `GSM2016, NSIDE ${params.nside}, ${$('gsm-frame').selectedOptions[0].text}` +
      (params.frame === 'lunar-farside' ? ` at ${params.epoch.replace('T', ' ')} UTC` : '');
    setSky(append ? state.sources.concat(sky) : sky, append ? `${state.skyOrigin || 'Sky'} + ${what}` : what);
    if (summary) {
      const [a1, a50, a99] = summary.alpha_percentiles || [];
      let msg = `GSM2016: ${summary.sources.toLocaleString()} sources (NSIDE ${summary.nside}, ${summary.frame}, ${summary.resolution} base maps) · ` +
        `f_ref ${MHz(summary.reference_frequency)} · ${summary.spectral_order > 1 ? 'α₁' : 'α'} median ${fmt(a50, 3)} (1–99%: ${fmt(a1, 3)} … ${fmt(a99, 3)}) · ` +
        ['alpha2', 'alpha3'].filter((k) => (summary[`${k}_percentiles`] || []).length)
          .map((k, j) => { const [lo, mid, hi] = summary[`${k}_percentiles`]; return `α${'₂₃'[j]} median ${fmt(mid, 3)} (${fmt(lo, 3)} … ${fmt(hi, 3)}) · `; }).join('') +
        `fit rms ${fmt(100 * summary.fit_rms_ln, 2)}% · total ${si(summary.total_flux_jy, 3, 'Jy')}`;
      if (summary.zenith_icrs_deg) {
        const [ra, dec] = summary.zenith_icrs_deg, [l, b] = summary.zenith_galactic_deg;
        const sun = summary.sun_elevation_deg;
        msg += ` · ${summary.epoch_utc.replace('.000', '')} UTC: zenith RA ${ra.toFixed(1)}°, Dec ${dec.toFixed(1)}° (l ${l.toFixed(1)}°, b ${b.toFixed(1)}°)` +
          ` · Sun elevation ${sun.toFixed(0)}° (lunar ${sun > 0 ? 'day' : 'night'}; not in the model) · Earth elevation ${summary.earth_elevation_deg.toFixed(0)}°`;
      }
      if (summary.pixels_with_nonpositive_samples || summary.pixels_without_fit) {
        msg += ` · GSM gave non-positive values: ${summary.pixels_with_nonpositive_samples} pixels fitted on the remaining maps, ${summary.pixels_without_fit} without a fit (α = 0)`;
      }
      toast(msg, 'ok');
    }
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    generateGsm.busy = false;
    button.textContent = label;
    renderGsmNote();
  }
}

// ---------------------------------------------------------------------------------------
// Environment rendering

const envChanged = debounce(() => refreshEnvironment(), 80);

function viewFreqFromSlider() {
  const [lo, hi] = M.physicalBand(state.array);
  state.viewFreq = lo + parseFloat($('view-freq').value) * (hi - lo);
  $('view-freq-out').textContent = MHz(state.viewFreq);
}

function syncViewFreqSlider() {
  const [lo, hi] = M.physicalBand(state.array);
  if (!(hi > lo)) return;
  state.viewFreq = Math.min(hi, Math.max(lo, state.viewFreq));
  $('view-freq').value = (state.viewFreq - lo) / (hi - lo);
  $('view-freq-out').textContent = MHz(state.viewFreq);
}

function refreshEnvironment() {
  const a = state.array;
  const err = validateArray(a);
  $('array-error').hidden = !err;
  $('array-error').textContent = err || '';
  $('run-btn').disabled = !!err || isActive();

  syncViewFreqSlider();
  const stats = M.arrayStats(a.antenna_positions);
  state.stats = stats;
  $('array-badge').textContent = `${a.antenna_positions.length} antennas`;
  $('sky-badge').textContent = `${state.sources.length} sources`;
  $('sky-origin').textContent = state.skyOrigin;
  $('sky-origin').hidden = !state.skyOrigin;
  $('array-caption').textContent = `${a.antenna_positions.length} antennas · ${si(stats.maxX - stats.minX, 3, 'm')} × ${si(stats.maxY - stats.minY, 3, 'm')}`;
  $('sky-caption').textContent = `Colour and size ∝ ${$('apparent').checked ? 'apparent' : 'intrinsic'} flux density at ${MHz(state.viewFreq)}`;

  renderSourceList();
  renderGsmNote();
  refreshDerived();
  timelineEnvChanged();
}

let timeline = null;
let outputs = null;
let transmitter = null;
const timelineEnvChanged = debounce(() => timeline && timeline.onEnvironmentChanged(), 400);

/** Everything that depends on the environment and the timeline step, but not on its inputs. */
function refreshDerived() {
  const on = enabledCals();
  $('cal-badge').textContent = on.length > 1 ? `${on.length} on` : on.length ? MODE_NAMES[on[0].mode] : 'off';
  const skipped = timeline ? timeline.count() - timeline.runCount() : 0;
  $('integrations-hint').textContent = skipped ? `(${skipped.toLocaleString()} skipped)` : '';
  refreshViewFreqDependent();
  if (!validateArray(state.array)) renderModelSpectrum();
  renderParams();
  renderWorkload();
  if (outputs) outputs.render();
  updateRunLabel();
  updateStale();
}

/** Sources and calibrators the environment views show: those at the current timeline step. */
function currentEnv() {
  return (timeline && timeline.env()) || { sources: state.sources, calibrators: [], trajectories: [] };
}

/** Integrations the next run simulates (skipped ones excluded). */
function integrationsCount() {
  return timeline ? timeline.runCount() : (parseInt($('integrations').value, 10) || 1);
}

const hasCalibrator = () => enabledCals().length > 0;

function updateRunLabel() {
  const save = outputs && outputs.any();
  $('run-btn').textContent = `▶ Run simulation${save ? ' & save' : ''}`;
}

/** Asks the user to pick one of `buttons` ({ label, value, primary }); resolves to its value, or '' if dismissed. */
function ask(title, text, buttons) {
  const dialog = $('choice-dialog');
  $('choice-title').textContent = title;
  $('choice-text').textContent = text;
  $('choice-buttons').replaceChildren(...buttons.map((b) => Object.assign(document.createElement('button'), {
    className: `btn${b.primary ? ' primary' : ''}`, value: b.value, textContent: b.label,
  })));
  dialog.returnValue = '';
  dialog.showModal();
  return new Promise((resolve) => dialog.addEventListener('close', () => resolve(dialog.returnValue), { once: true }));
}

function setIntegrations(n) {
  $('integrations').value = n;
  $('integrations').dispatchEvent(new Event('input'));
}

function throttle(fn, ms) {
  let last = 0, timer = null;
  return () => {
    const wait = ms - (performance.now() - last);
    if (wait <= 0) { last = performance.now(); fn(); return; }
    clearTimeout(timer);
    timer = setTimeout(() => { last = performance.now(); fn(); }, wait);
  };
}

/** A new timeline step: views redraw immediately, the heavier model and table at most ~3×/s. */
const stepModels = throttle(() => { renderModelSpectrum(); renderParams(); }, 300);
function onTimelineStep() {
  refreshViewFreqDependent({ beam: false });
  stepModels();
}

/** Views that depend on the view frequency (cheap ones redraw immediately). */
function refreshViewFreqDependent({ beam = true } = {}) {
  const env = {
    positions: state.array.antenna_positions,
    ...currentEnv(),
    freq: state.viewFreq,
    cmap: state.cmap,
    scale: $('sky-scale').value,
  };
  scene.set(env);
  arrayView.set({ positions: env.positions, calibrators: env.calibrators });
  skyView.set({ ...env, apparent: $('apparent').checked });
  modelPlot.vlines = [{ x: state.viewFreq / 1e6, label: 'view' }];
  modelPlot.render();
  if (beam) requestBeam();
}

const requestBeam = debounce(async () => {
  const { xs, ys } = relativeXY(state.array.antenna_positions);
  const freq = state.viewFreq;
  const token = (requestBeam.token = (requestBeam.token || 0) + 1);
  try {
    const { result } = await compute('beam', { xs, ys, freq, size: 96 });
    if (token !== requestBeam.token) return;
    beamView.setOptions({ cmap: state.cmap });
    beamView.set(skyImageData(result, 96));
    const res = (M.C / freq) / (state.stats.maxBaseline || 1);
    $('beam-caption').textContent = `Zenith-steered power pattern at ${MHz(freq)} · resolution λ/B ≈ ${(res * DEG).toFixed(2)}°`;
  } catch (e) { toast(`Beam: ${e.message}`, 'error'); }
}, 150);

/**
 * Frequencies to evaluate the analytic model at: `n` across the first Nyquist zone, the band edges,
 * and the analysis channels the calibrators' spectra occupy (so their lines are not missed).
 */
function bandFreqs(array, n = 700, shapesOrNull = []) {
  const lo = array.downmix_frequency, hi = array.downmix_frequency + array.sample_frequency / 2;
  const f = [];
  for (let i = 0; i < n; i++) f.push(lo + ((i + 0.5) / n) * (hi - lo));
  // Make sure the band edges are sampled exactly so the model doesn't look clipped.
  f.push(...M.physicalBand(array));
  const shapes = [...new Set(shapesOrNull.filter(Boolean))];
  for (const shape of shapes) {
    const W = shape.values.length;
    const lines = [];
    for (let c = 0; c <= W / 2; c++) if (shape.values[c] > 0) lines.push(shape.fdm + c * shape.df);
    const step = Math.ceil((lines.length * shapes.length) / 6000);
    for (let i = 0; i < lines.length; i += step) f.push(lines[i]);
  }
  return Float64Array.from(new Set(f)).sort();
}

/** Model series of each calibrator in `cals`, labelled by name when there are several. */
function calibratorSeries(cals, x, m) {
  return cals.map((c, k) => ({ label: `${cals.length > 1 ? c.name : 'Calibrator'} (array mean)`, x, y: m.cals[k], color: c.color }));
}

function renderModelSpectrum() {
  const a = state.array;
  const env = currentEnv();
  const f = bandFreqs(a, 700, env.calibrators.map((c) => c.shape));
  const m = M.modelSpectrum(a, env.sources, env.calibrators, f);
  const x = Array.from(f, (v) => v / 1e6);
  const series = [
    { label: 'Total', x, y: m.total, color: 'fg', width: 2 },
    { label: 'Sky sources', x, y: m.sky, color: 's1' },
    { label: 'System noise', x, y: m.noise, color: 's2' },
    ...calibratorSeries(env.calibrators, x, m),
  ];
  const [lo, hi] = M.physicalBand(a);
  modelPlot.opts.xDomain = [a.downmix_frequency / 1e6, (a.downmix_frequency + a.sample_frequency / 2) / 1e6];
  modelPlot.set(series, { bands: [{ x0: lo / 1e6, x1: hi / 1e6 }], vlines: [{ x: state.viewFreq / 1e6, label: 'view' }] });
}

function renderParams() {
  const a = state.array, s = state.stats;
  const fs = a.sample_frequency, W = a.sample_window_size, R = +$('freq-res').value;
  const [lo, hi] = M.physicalBand(a);
  const fc = (lo + hi) / 2;
  const lamMin = M.C / hi, lamMax = M.C / lo, lamC = M.C / fc;
  const binsIn = Math.max(0, Math.floor((a.bandpass[1] * W) / fs) - Math.ceil((a.bandpass[0] * W) / fs) + 1);
  const env = currentEnv();
  const above = env.sources.filter((x) => x.z > 0).length;
  const m = M.modelSpectrum(a, env.sources, env.calibrators, [state.viewFreq]);
  const aliasF = M.C / (2 * s.minSpacing);
  const alias = Number.isFinite(aliasF)
    ? (aliasF < hi ? [`above ${MHz(aliasF)}`, 'warn'] : ['none in band', 'ok'])
    : ['–', ''];
  const groups = [
    ['Sampling', [
      ['Sample rate / Nyquist', `${si(fs, 4, 'Hz')} / ${si(fs / 2, 4, 'Hz')}`],
      ['Window', `${W} samples · ${si(W / fs, 3, 's')}`],
      ['Channel width fs/W', si(fs / W, 4, 'Hz')],
      ['Synthesis bins W·R', `${W * R} · ${si(fs / (W * R), 3, 'Hz')}`],
      ['Sky band (physical)', `${MHz(lo)} – ${MHz(hi)}`],
      ['Channels in band', binsIn],
      ['Wavelength', `${fmt(lamMin, 3)} – ${fmt(lamMax, 3)} m`],
    ]],
    ['Array', [
      ['Antennas / baselines', `${s.n} / ${s.baselines.toLocaleString()}`],
      ['Longest baseline', si(s.maxBaseline, 4, 'm')],
      ['Min. spacing', Number.isFinite(s.minSpacing) ? si(s.minSpacing, 3, 'm') : '–'],
      ['Resolution λ/B at centre', `${((lamC / s.maxBaseline) * DEG).toFixed(2)}°`],
      ['Grating lobes (d > λ/2)', alias[0], alias[1]],
      ['Geometry', s.planar ? 'planar' : `non-planar (Δz ${si(s.maxZ - s.minZ, 3, 'm')})`],
    ]],
    [`Sky at ${MHz(state.viewFreq)}${timeline && timeline.varies() ? ` · integration ${timeline.step() + 1}` : ''}`, [
      ['Sources (above horizon)', `${env.sources.length} (${above})`],
      ['Apparent sky (per bin)', `${fmt(m.sky[0], 4)} Jy`],
      ['System noise (per bin)', `${fmt(m.noise[0], 4)} Jy`],
      ['A_eff (noise)', `${fmt(M.effectiveAperture(state.viewFreq), 3)} m² · T_sys ${fmt(a.system_noise_intensity / M.K_B_JY, 3)} K`],
      ['Sky / noise', `${fmt(m.sky[0] / m.noise[0], 3)}`],
      ...env.calibrators.flatMap((c, k) => (c.shape ? calibratorRows(m.cals[k][0], c, env.calibrators.length > 1) : [])),
    ]],
    ['Output', [
      ['Samples per window', (s.n * W).toLocaleString()],
      ['Bytes per window (c64)', si(s.n * W * 8, 3, 'B')],
      ['Equivalent data rate', `${si(s.n * fs * 8, 3, 'B')}/s`],
    ]],
  ];
  $('params').innerHTML = groups.map(([title, rows]) =>
    `<h4>${title}</h4><dl>${rows.map(([k, v, cls]) => `<dt>${k}</dt><dd class="${cls || ''}">${v}</dd>`).join('')}</dl>`).join('');
}

/** Derived parameters of a calibrator `c` (with its shape) whose per-bin power at the view frequency is `perBin`. */
function calibratorRows(perBin, c, named) {
  const ctr = M.centroid(state.array.antenna_positions);
  const d = [c.position.x - ctr.x, c.position.y - ctr.y, c.position.z - ctr.z];
  const dist = Math.hypot(...d);
  const vr = (c.velocity.x * d[0] + c.velocity.y * d[1] + c.velocity.z * d[2]) / dist;
  const who = named ? c.name : 'Calibrator';
  const flux = M.meanCalibratorPower(c, state.array.antenna_positions);
  const rows = [
    [`${who} distance`, si(dist, 4, 'm')],
    [`${who} elevation`, `${(Math.asin(d[2] / dist) * DEG).toFixed(1)}°${c.silent ? ' (off)' : ''}`],
    [`${who} flux (mean)`, `${fmt(flux, 4)} W/m²`],
    [`${who} (per bin)`, `${fmt(perBin, 4)} Jy`],
    [`${who} peak (per bin)`, `${fmt(flux * c.shape.peak, 4)} Jy at ${MHz(c.shape.refFreq)}`],
  ];
  const carrier = state.calibrators.find((k) => k.name === c.name)?.transmitter.frequency;
  if (vr && carrier) rows.push([`Doppler shift (${named ? `${c.name} carrier` : 'carrier'})`, si((-carrier * vr) / M.C, 4, 'Hz')]);
  return rows;
}

function workloadTerms() {
  const a = state.array;
  const R = +$('freq-res').value;
  const fine = Math.max(0, ((a.bandpass[1] - a.bandpass[0]) * a.sample_window_size * R) / a.sample_frequency);
  const sources = timeline ? timeline.sourceCount() : state.sources.length;
  return a.antenna_positions.length * (sources + 2) * fine;
}

function renderWorkload() {
  const terms = workloadTerms();
  const n = integrationsCount();
  const rate = state.rates[state.runtime];
  let text = `≈ ${si(terms, 3)} source·bin terms per window`;
  if (rate) {
    const t = (terms * n) / rate;
    text += ` · est. ${si(t, 2, 's')} for ${n} window${n > 1 ? 's' : ''} on ${state.runtime.toUpperCase()}`;
  }
  const el = $('workload-note');
  el.textContent = text;
  el.classList.toggle('warn', state.runtime === 'cpu' && terms > 2e9);
  if (state.runtime === 'cpu' && terms > 2e9) el.textContent += ' — heavy for the CPU runtime; consider the GPU or fewer sources.';
}

// ---------------------------------------------------------------------------------------
// Running

function isActive() {
  const s = $('run-state').dataset.state;
  return s === 'running' || s === 'initializing';
}

/** Request for a plain run; with `key`, the transmit buffer is replaced by its identity. */
function buildRequest({ key = false } = {}) {
  let seed = $('seed').value.trim();
  const rng_seed = seed === '' ? Math.floor(Math.random() * 2 ** 32) : Number(seed);
  return {
    runtime: state.runtime,
    frequency_resolution: +$('freq-res').value,
    rng_seed,
    integrations: parseInt($('integrations').value, 10),
    array: state.array,
    sources: state.sources.map(M.sourceDto),
    // Kinematic calibrators; series ones only run through the pipeline (timeline.requestPart).
    calibrators: state.calibrators.filter((c) => c.mode === 'fixed').map((c) => ({
      name: c.name, position: c.position, velocity: c.velocity, acceleration: c.acceleration,
      transmitter: transmitter.dto(c, c.transmitter.power, { key }),
    })),
    analysis: { window: $('window-fn').value, channels: parseInt($('channels').value, 10) },
  };
}

/**
 * Request for the timeline/output path: per-integration times, calibrator positions and sky
 * frames, and the data products to save.
 */
function buildPipelineRequest() {
  const base = buildRequest();
  return {
    runtime: base.runtime, frequency_resolution: base.frequency_resolution, rng_seed: base.rng_seed,
    array: base.array, analysis: base.analysis, products: outputs.products(), output_name: outputs.name(),
    ...timeline.requestPart(),
  };
}

/** Runs that vary over the timeline or save products go through the pipeline. */
const viaPipeline = () => timeline.needsPipeline() || outputs.any();

/** Identity of the configuration that affects results (seed excluded when random). */
function configKey() {
  try {
    const r = buildRequest({ key: true });
    if ($('seed').value.trim() === '') r.rng_seed = 'random';
    if (timeline.needsPipeline()) {
      r.timeline = timeline.requestPart({ key: true });
      delete r.integrations;
      delete r.calibrators;
      delete r.sources;
    }
    return JSON.stringify(r);
  } catch {
    return null;
  }
}

async function startRun() {
  const pipeline = viaPipeline();
  let request;
  try {
    request = pipeline ? buildPipelineRequest() : buildRequest();
  } catch (e) {
    toast(`Cannot run: ${e.message}`, 'error');
    return;
  }
  try {
    const { run_id } = await api(pipeline ? '/pipeline/run' : '/run', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request),
    });
    state.activeRunId = run_id;
    // The Signals/Imaging tabs compare against this: the sky at the middle integration, without
    // moving calibrators.
    state.pendingSnapshot = {
      key: configKey(),
      sources: timeline.snapshotSources(),
      calibrators: timeline.snapshotCalibrators(),
      terms: workloadTerms(),
      runtime: state.runtime,
    };
    setStatus({ state: 'initializing', kind: pipeline ? 'pipeline' : 'simulation', completed: 0, total: integrationsCount(), elapsed_s: 0 });
    pollStatus();
  } catch (e) {
    toast(`Could not start simulation: ${e.message}`, 'error');
  }
}

function setStatus(s) {
  const el = $('run-state');
  el.dataset.state = s.state;
  const pct = s.total ? (100 * s.completed) / s.total : 0;
  $('progress-bar').style.width = `${s.state === 'idle' ? 0 : pct}%`;
  const elapsed = si(s.elapsed_s, 3, 's');
  const text = {
    idle: 'Idle',
    initializing: `Initialising ${state.runtime.toUpperCase()} runtime…`,
    running: `Simulating · integration ${s.completed}/${s.total} · ${elapsed}`,
    finished: `Finished · ${s.completed} integrations in ${elapsed}`,
    cancelled: `Cancelled after ${s.completed}/${s.total} integrations`,
    failed: `Failed: ${s.message || 'unknown error'}`,
  }[s.state];
  $('status-text').textContent = text;
  $('status-text').title = text;
  const active = s.state === 'running' || s.state === 'initializing';
  $('cancel-btn').hidden = !active;
  $('run-btn').disabled = active || !!validateArray(state.array);
}

async function pollStatus() {
  let s;
  try { s = await api('/run/status'); } catch (e) { toast(`Lost connection to server: ${e.message}`, 'error'); return; }
  setStatus(s);
  if (s.state === 'running' || s.state === 'initializing') { setTimeout(pollStatus, 400); return; }
  if (s.state === 'failed') { toast(s.message || 'Simulation failed', 'error'); return; }
  if ((s.state === 'finished' || s.state === 'cancelled') && s.completed > 0) {
    if (state.pendingSnapshot) { state.snapshot = state.pendingSnapshot; state.pendingSnapshot = null; }
    await loadResults();
    const saved = s.kind === 'pipeline' ? await outputs.onJobFinished() : null;
    if (!saved || !saved.file) toast(`Simulation ${s.state} — ${s.completed} integrations. See Signals and Imaging.`, 'ok');
  }
}

async function loadResults() {
  let summary;
  try { summary = await api('/run/summary'); } catch (e) { toast(e.message, 'error'); return; }
  state.run = summary;
  const snap = state.snapshot;
  if (snap) {
    const perWindow = median(summary.timing.window_s);
    if (perWindow > 0 && snap.runtime === summary.runtime) state.rates[summary.runtime] = snap.terms / perWindow;
  }
  state.runKey = snap ? snap.key : null;
  if (state.antenna >= summary.antennas) state.antenna = 0;
  $('signals-empty').hidden = $('imaging-empty').hidden = true;
  $('signals-content').hidden = $('imaging-content').hidden = false;
  $('signals-dot').hidden = $('imaging-dot').hidden = currentTab() === 'signals';
  $('antenna-index').max = summary.antennas - 1;

  renderRunTiles();
  renderPowerMap();
  renderWaterfall();
  setupChannels();
  renderWorkload();
  updateStale();
  await selectAntenna(state.antenna);
  loadImage();
}

function updateStale() {
  if (!state.run) return;
  const stale = !state.runKey || state.runKey !== configKey();
  $('signals-stale').hidden = $('imaging-stale').hidden = !stale;
}

// ---------------------------------------------------------------------------------------
// Signals

function runSources() { return state.snapshot ? state.snapshot.sources : state.sources; }
/** Calibrators of the latest run for the analytic model (static ones, with their spectral shapes). */
function runCalibrators() {
  if (!state.run || !state.run.calibrators) return [];
  return state.snapshot ? state.snapshot.calibrators : timeline.snapshotCalibrators();
}

function renderRunTiles() {
  const r = state.run;
  const perWindow = median(r.timing.window_s);
  const samples = r.antennas * r.array.sample_window_size;
  tiles($('run-tiles'), [
    ['Runtime', r.runtime.toUpperCase(), `seed ${r.rng_seed} · R = ${r.frequency_resolution}`],
    ['Windows', `${r.integrations}${r.integrations < r.requested_integrations ? ` / ${r.requested_integrations}` : ''}`, `${r.window} window`],
    ['Time per window', si(perWindow, 3, 's'), `init ${si(r.timing.init_s, 3, 's')}`],
    ['Throughput', `${si(samples / perWindow, 3, 'S')}/s`, `${si(r.array.sample_frequency * r.antennas, 3, 'S')}/s real-time`],
    realtimeTile((r.array.sample_window_size / r.array.sample_frequency) / perWindow),
    ['Simulated data', si(samples * 8 * r.integrations, 3, 'B'), `${r.antennas} antennas × ${r.array.sample_window_size} × ${r.integrations}`],
    ['Total time', si(r.timing.total_s, 3, 's'), `${r.sources} sources${r.calibrators ? ` + ${r.calibrators} calibrator${r.calibrators > 1 ? 's' : ''}` : ''}`],
  ]);
}

function realtimeTile(ratio) {
  return ratio >= 1
    ? ['Real-time factor', `${fmt(ratio, 3)}× faster`, 'than the simulated signal duration']
    : ['Real-time factor', `${Math.round(1 / ratio).toLocaleString()}× slower`, 'than the simulated signal duration'];
}

function renderPowerMap() {
  const r = state.run;
  powerMap.set({
    positions: r.array.antenna_positions, calibrators: runCalibrators(), values: r.antenna_power, selected: state.antenna, cmap: state.cmap,
  });
}

function spectrumAxis(r) {
  return Array.from(r.mean_spectrum, (_, i) => (r.f0 + i * r.df) / 1e6);
}

async function selectAntenna(i) {
  const r = state.run;
  if (!r) return;
  i = Math.max(0, Math.min(r.antennas - 1, i | 0));
  state.antenna = i;
  $('antenna-index').value = i;
  powerMap.env.selected = i;
  powerMap.render();
  const token = (selectAntenna.token = (selectAntenna.token || 0) + 1);
  let data;
  try { data = await api(`/run/antenna/${i}`); } catch (e) { toast(e.message, 'error'); return; }
  if (token !== selectAntenna.token) return;
  state.antennaData = data;
  const p = data.position;
  $('antenna-pos').textContent = `(${fmt(p.x)}, ${fmt(p.y)}, ${fmt(p.z)}) m`;
  renderTimeseries();
  renderSpectrum();
  renderHistogram();
}

function renderTimeseries() {
  const d = state.antennaData, r = state.run;
  const fs = r.array.sample_frequency;
  const x = Array.from(d.re, (_, i) => (i / fs) * 1e6);
  const keep = tsPlot.series.length > 0;
  tsPlot.set([
    { label: 'Real', x, y: d.re, color: 's1', width: 1.2 },
    { label: 'Imaginary', x, y: d.im, color: 's2', width: 1.2 },
  ], { keepView: keep });
  if (!keep) tsPlot.setView([0, x[Math.min(x.length - 1, 511)]]);
  $('ts-caption').textContent = `Antenna ${d.index}, last of ${r.integrations} window${r.integrations > 1 ? 's' : ''} · ${d.re.length} samples · drag to zoom, double-click to reset`;
}

function renderSpectrum() {
  const r = state.run, d = state.antennaData;
  const x = spectrumAxis(r);
  const a = r.array;
  // Analytic model for this antenna (calibrator power depends on its position).
  const sources = runSources(), cals = runCalibrators().filter((c) => c.shape);
  const f = bandFreqs(a, 400, cals.map((c) => c.shape));
  const m = M.modelSpectrum(a, sources, [], f);
  const calP = cals.map((c) => M.calibratorPower(c, d.position));
  const model = Array.from(m.total, (v, k) => cals.reduce((sum, c, j) => sum + calP[j] * c.shape.at(f[k]), v));
  const series = [
    { label: `Antenna ${d.index}`, x, y: d.spectrum, color: 's1', width: 1.2 },
    { label: 'Array mean', x, y: r.mean_spectrum, color: 's2', width: 1.2 },
    { label: 'Analytic model', x: Array.from(f, (v) => v / 1e6), y: model, color: 'fg', width: 1.5, dash: true },
  ];
  const [lo, hi] = M.physicalBand(a);
  const margin = (hi - lo) * 0.15;
  specPlot.opts.xDomain = [(a.downmix_frequency - a.sample_frequency / 2) / 1e6, (a.downmix_frequency + a.sample_frequency / 2) / 1e6];
  const keep = specPlot.series.length > 0;
  specPlot.set(series, { bands: [{ x0: lo / 1e6, x1: hi / 1e6 }], keepView: keep });
  if (!keep) specPlot.setView([(lo - margin) / 1e6, (hi + margin) / 1e6]);
  const [i0, i1] = r.band;
  let meas = 0, mod = 0, n = 0;
  for (let i = i0; i <= i1; i++) { meas += r.mean_spectrum[i]; n++; }
  meas /= n;
  const mf = M.modelSpectrum(a, sources, cals, x.slice(i0, i1 + 1).map((v) => v * 1e6));
  mod = mf.total.reduce((s, v) => s + (Number.isFinite(v) ? v : 0), 0) / mf.total.filter(Number.isFinite).length;
  $('spec-caption').textContent = `Mean over ${r.integrations} integration${r.integrations > 1 ? 's' : ''} · in-band array mean / model = ${fmt(meas / mod, 4)}`;
}

function renderHistogram() {
  const d = state.antennaData;
  const all = [...d.re, ...d.im];
  let s2 = 0;
  for (const v of all) s2 += v * v;
  const sigma = Math.sqrt(s2 / all.length) || 1;
  const bins = 61, lim = 4 * sigma, w = (2 * lim) / bins;
  const hist = (vals) => {
    const h = new Float64Array(bins);
    for (const v of vals) { const b = Math.floor((v + lim) / w); if (b >= 0 && b < bins) h[b]++; }
    return Array.from(h, (c) => c / (vals.length * w));
  };
  const x = Array.from({ length: bins }, (_, i) => -lim + (i + 0.5) * w);
  const gauss = x.map((v) => Math.exp(-(v * v) / (2 * sigma * sigma)) / (sigma * Math.sqrt(2 * Math.PI)));
  histPlot.set([
    { label: 'Real', x, y: hist(d.re), color: 's1' },
    { label: 'Imaginary', x, y: hist(d.im), color: 's2' },
    { label: `Gaussian σ=${fmt(sigma, 3)}`, x, y: gauss, color: 'fg', dash: true },
  ]);
}

function renderWaterfall() {
  const r = state.run, wf = r.waterfall;
  const [lo, hi] = M.physicalBand(r.array);
  const c0 = Math.max(0, Math.floor((lo - wf.f0) / wf.df));
  const c1 = Math.min(wf.cols, Math.ceil((hi - wf.f0) / wf.df));
  const nc = Math.max(1, c1 - c0);
  const values = new Float32Array(wf.rows * nc);
  for (let row = 0; row < wf.rows; row++) for (let c = 0; c < nc; c++) values[row * nc + c] = wf.data[row * wf.cols + c0 + c];
  waterfall.setOptions({ cmap: state.cmap });
  waterfall.set({
    values, cols: nc, rows: wf.rows,
    x0: (wf.f0 + c0 * wf.df) / 1e6, x1: (wf.f0 + (c0 + nc) * wf.df) / 1e6, y0: 0, y1: wf.rows,
  });
}

// ---------------------------------------------------------------------------------------
// Imaging

function setupChannels() {
  const ch = state.run.channels;
  const slider = $('channel');
  slider.max = ch.length - 1;
  // Default to the channel nearest the environment's view frequency.
  let best = 0;
  ch.forEach((c, i) => { if (Math.abs(c.frequency - state.viewFreq) < Math.abs(ch[best].frequency - state.viewFreq)) best = i; });
  state.channel = best;
  slider.value = best;
  $('channel-out').textContent = MHz(ch[best].frequency);
}

function brightestAbove(freq, n) {
  return runSources()
    .filter((s) => s.z > 0)
    .map((s) => ({ s, v: M.sourceIntensity(s, freq) * M.sourceGain(s) }))
    .sort((a, b) => b.v - a.v)
    .slice(0, n);
}

function drawImageOverlay(ctx, toPx, t) {
  if (!state.run) return;
  const freq = state.run.channels[state.channel]?.frequency;
  if ($('img-overlay').checked && freq) {
    ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1.2; ctx.globalAlpha = 0.85;
    for (const { s } of brightestAbove(freq, 25)) {
      const [x, y] = toPx(s.x, s.y);
      ctx.beginPath(); ctx.arc(x, y, 6, 0, 2 * Math.PI); ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }
  const cals = runCalibrators();
  const c = M.centroid(state.run.array.antenna_positions);
  for (const cal of cals) {
    const d = [cal.position.x - c.x, cal.position.y - c.y, cal.position.z - c.z];
    const n = Math.hypot(...d);
    if (d[2] > 0) {
      const [x, y] = toPx(d[0] / n, d[1] / n);
      ctx.strokeStyle = t[cal.color] || t.s3; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(x, y - 8); ctx.lineTo(x + 7, y); ctx.lineTo(x, y + 8); ctx.lineTo(x - 7, y); ctx.closePath(); ctx.stroke();
      if (cal.named) {
        ctx.fillStyle = '#ffffff'; ctx.font = t.font; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
        ctx.fillText(cal.name, x + 10, y);
      }
    }
  }
}

async function loadImage() {
  const r = state.run;
  if (!r) return;
  const ch = state.channel, size = +$('img-size').value;
  const freq = r.channels[ch].frequency;
  $('channel-out').textContent = MHz(freq);
  const token = (loadImage.token = (loadImage.token || 0) + 1);
  const opts = { cmap: $('img-cmap').value, scale: $('img-scale').value, dynamicRange: 30 };
  for (const v of [dirtyImage, expectedImage]) v.setOptions(opts);
  psfImage.setOptions({ cmap: $('img-cmap').value });

  const { xs, ys } = relativeXY(r.array.antenna_positions);
  const noisePower = r.array.system_noise_intensity / M.effectiveAperture(freq);
  const sources = runSources().map(({ x, y, z, f0, I0, alpha, alpha2, alpha3 }) => ({ x, y, z, f0, I0, alpha, alpha2, alpha3 }));
  // Calibrators enter as far-field point sources in their directions from the array centre,
  // carrying the mean per-antenna power (exact for distant emitters such as satellites).
  const c = M.centroid(r.array.antenna_positions);
  for (const cal of runCalibrators()) {
    if (!cal.shape) continue;
    const d = [cal.position.x - c.x, cal.position.y - c.y, cal.position.z - c.z];
    const n = Math.hypot(...d);
    const z = d[2] / n;
    const power = M.meanCalibratorPower(cal, r.array.antenna_positions) * cal.shape.at(freq);
    if (z > 0 && power > 0) sources.push({ x: d[0] / n, y: d[1] / n, z, f0: freq, I0: power / (z * z), alpha: 0 });
  }

  const dirtyP = api(`/run/image?channel=${ch}&size=${size}`);
  const expectedP = compute('expected', { xs, ys, sources, freq, size, noisePower });
  const psfP = compute('beam', { xs, ys, freq, size });

  let dirty, expected;
  try {
    const img = await dirtyP;
    if (token !== loadImage.token) return;
    dirty = Float32Array.from(img.data, (v) => (v === null ? NaN : v));
    dirtyImage.set(skyImageData(dirty, size));
    renderImageTiles(img, dirty, null, noisePower);
  } catch (e) { toast(`Image: ${e.message}`, 'error'); return; }
  try {
    const { result } = await expectedP;
    if (token !== loadImage.token) return;
    expected = result;
    expectedImage.set(skyImageData(expected, size));
  } catch (e) { toast(`Expected image: ${e.message}`, 'error'); }
  applySharedRange(dirty, expected);
  try {
    const { result } = await psfP;
    if (token !== loadImage.token) return;
    psfImage.set(skyImageData(result, size));
  } catch (e) { toast(`PSF: ${e.message}`, 'error'); }
  if (dirty && expected) renderImageTiles(loadImage.lastImg, dirty, expected, noisePower);
}

function applySharedRange(dirty, expected) {
  if (!$('img-shared').checked || !dirty || !expected) {
    dirtyImage.setRange(null); expectedImage.setRange(null);
    return;
  }
  let lo = Infinity, hi = -Infinity;
  for (const arr of [dirty, expected]) for (const v of arr) if (Number.isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; }
  dirtyImage.setRange([lo, hi]); expectedImage.setRange([lo, hi]);
}

function renderImageTiles(img, dirty, expected, noisePower) {
  if (img) loadImage.lastImg = img;
  img = loadImage.lastImg;
  const size = img.size, r = state.run;
  let peak = -Infinity, pi = 0;
  dirty.forEach((v, i) => { if (v > peak) { peak = v; pi = i; } });
  const l = -1 + ((pi % size) + 0.5) * (2 / size), m = -1 + (Math.floor(pi / size) + 0.5) * (2 / size);
  const el = Math.acos(Math.min(1, Math.hypot(l, m))) * DEG;
  const az = ((Math.atan2(m, l) * DEG) + 360) % 360;
  const floor = median(dirty);
  const items = [
    ['Channel frequency', MHz(img.frequency), `λ = ${fmt(M.C / img.frequency, 3)} m`],
    ['Peak', fmt(peak, 4), `el ${el.toFixed(1)}° · az ${az.toFixed(1)}°`],
    ['Median level', fmt(floor, 4), `noise floor N/A_eff/A = ${fmt(noisePower / r.antennas, 3)}`],
    ['Peak / median', `${fmt(10 * Math.log10(peak / floor), 3)} dB`, `${r.integrations} integration${r.integrations > 1 ? 's' : ''}`],
  ];
  if (expected) {
    let num = 0, den = 0;
    for (let i = 0; i < dirty.length; i++) if (Number.isFinite(dirty[i]) && Number.isFinite(expected[i])) { num += dirty[i]; den += expected[i]; }
    items.push(['Dirty / expected (sum)', fmt(num / den, 4), 'flux agreement over the sky']);
  }
  items.push(['Server imaging time', si(img.compute_s, 3, 's'), `${size}² pixels × ${r.antennas} antennas`]);
  tiles($('image-tiles'), items);
}

// ---------------------------------------------------------------------------------------
// Tabs, theme, bindings

function currentTab() { return document.querySelector('.tabs .on').dataset.tab; }

function showTab(name) {
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === name));
  document.querySelectorAll('.tab-panel').forEach((p) => { p.hidden = p.id !== `tab-${name}`; });
  const dot = $(`${name}-dot`);
  if (dot) dot.hidden = true;
  if (name === 'outputs' && outputs) outputs.loadFiles();
  try { localStorage.setItem('fringe.tab', name); } catch { /* storage unavailable */ }
}

function applyTheme(theme) {
  if (theme) document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
  allViews.forEach((v) => v.render());
  [modelPlot, tsPlot, specPlot, histPlot].forEach((p) => p.renderLegend());
}

/** Sidebar width: drag the handle (or use arrow keys on it), double-click to reset; remembered. */
function initSidebarResize() {
  const layout = document.querySelector('.layout'), handle = $('sidebar-resizer');
  const DEFAULT = 320, MIN = 260;
  const max = () => Math.max(MIN, Math.min(720, window.innerWidth * 0.6));
  const clamp = (w) => Math.round(Math.min(max(), Math.max(MIN, w)));
  let width = DEFAULT;
  const set = (w, save = true) => {
    width = clamp(w);
    layout.style.setProperty('--sidebar-w', `${width}px`);
    handle.setAttribute('aria-valuenow', width);
    if (save) try { localStorage.setItem('fringe.sidebar', width); } catch { /* storage unavailable */ }
  };
  try { set(parseFloat(localStorage.getItem('fringe.sidebar')) || DEFAULT, false); } catch { set(DEFAULT, false); }
  handle.setAttribute('aria-valuemin', MIN);

  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    const x0 = e.clientX, w0 = width;
    handle.classList.add('dragging');
    document.body.classList.add('resizing-sidebar');
    const move = (ev) => set(w0 + ev.clientX - x0, false);
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.classList.remove('dragging');
      document.body.classList.remove('resizing-sidebar');
      set(width);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up, { once: true });
    handle.addEventListener('pointercancel', up, { once: true });
  });
  handle.addEventListener('dblclick', () => set(DEFAULT));
  handle.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 64 : 16;
    if (e.key === 'ArrowLeft') set(width - step);
    else if (e.key === 'ArrowRight') set(width + step);
    else if (e.key === 'Home') set(MIN);
    else if (e.key === 'End') set(max());
    else return;
    e.preventDefault();
  });
  window.addEventListener('resize', () => { if (width > max()) set(width, false); });
}

function bind() {
  document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));

  $('theme-toggle').addEventListener('click', () => {
    const dark = getComputedStyle(document.documentElement).colorScheme === 'dark';
    const next = dark ? 'light' : 'dark';
    try { localStorage.setItem('fringe.theme', next); } catch { /* storage unavailable */ }
    applyTheme(next);
  });

  // Simulation
  document.querySelectorAll('#runtime button').forEach((b) => b.addEventListener('click', () => {
    state.runtime = b.dataset.value;
    document.querySelectorAll('#runtime button').forEach((x) => x.classList.toggle('on', x === b));
    renderWorkload(); updateStale();
  }));
  for (const id of ['freq-res', 'seed', 'window-fn', 'channels']) {
    $(id).addEventListener('input', () => { renderParams(); renderWorkload(); outputs.render(); updateStale(); });
  }
  $('run-btn').addEventListener('click', startRun);
  $('cancel-btn').addEventListener('click', () => api('/run/cancel', { method: 'POST' }).catch((e) => toast(e.message, 'error')));

  // Array
  for (const id of ['fs', 'fdown', 'bp-min', 'bp-max', 'window-size', 'noise']) $(id).addEventListener('input', readArrayInputs);
  $('array-default').addEventListener('click', resetArray);
  $('array-file').addEventListener('change', async (e) => {
    try { state.array = M.parseArrayJson(await readFile(e.target)); writeArrayInputs(); state.antenna = 0; envChanged(); toast('Array loaded'); } catch (err) { toast(`Array file: ${err.message}`, 'error'); }
  });
  $('array-export').addEventListener('click', () => download('array.json', M.serializeArray(state.array), 'application/json'));
  $('gen-layout').addEventListener('change', renderGenParams);
  $('array-python').addEventListener('click', () => openPythonDialog('layout'));
  $('series-python').addEventListener('click', () => openPythonDialog('calibrator'));
  $('gen-array').addEventListener('click', generateArray);

  // Sky
  $('sky-default').addEventListener('click', () => loadDefaultSky().catch((e) => toast(e.message, 'error')));
  $('sky-file').addEventListener('change', async (e) => {
    const name = e.target.files[0]?.name || 'file';
    try { setSky(M.parseSourcesCsv(await readFile(e.target)), `Loaded from ${name}`); toast(`${state.sources.length} sources loaded`); } catch (err) { toast(`Sources file: ${err.message}`, 'error'); }
  });
  $('sky-export').addEventListener('click', () => download('sources.csv', M.serializeSources(state.sources), 'text/csv'));
  $('sky-clear').addEventListener('click', () => setSky([], ''));
  const genSky = (append) => {
    const n = Math.max(1, parseInt($('sky-n').value, 10) || 1);
    const fc = (M.physicalBand(state.array)[0] + M.physicalBand(state.array)[1]) / 2;
    const seed = parseInt($('sky-seed').value, 10) || 0;
    const sky = M.randomSky(n, seed, { f0: fc, alpha: parseFloat($('sky-alpha').value) || 0 });
    const what = `${n} random sources (seed ${seed})`;
    setSky(append ? state.sources.concat(sky) : sky, append ? `${state.skyOrigin || 'Sky'} + ${what}` : what);
  };
  $('sky-generate').addEventListener('click', () => genSky(false));
  $('sky-append').addEventListener('click', () => genSky(true));
  for (const id of ['gsm-nside', 'gsm-maps', 'gsm-order', 'gsm-frame', 'gsm-epoch', 'gsm-fmin', 'gsm-fmax', 'gsm-resolution', 'gsm-horizon']) {
    $(id).addEventListener('input', renderGsmNote);
  }
  $('gsm-replace').addEventListener('click', () => generateGsm(false));
  $('gsm-append').addEventListener('click', () => generateGsm(true));
  $('src-add').addEventListener('click', () => {
    const v = (id) => parseFloat($(id).value);
    if (!(v('src-f0') > 0) || !(v('src-i') >= 0)) return toast('Source needs f₀ > 0 and S₀ ≥ 0', 'error');
    setSky(state.sources.concat([M.makeSource(v('src-ra') / DEG, v('src-dec') / DEG, v('src-f0') * 1e6, v('src-i'), v('src-alpha') || 0, v('src-alpha2') || 0, v('src-alpha3') || 0)]), editedOrigin());
  });

  // Calibrator
  document.querySelectorAll('#cal-mode button').forEach((b) => b.addEventListener('click', () => setCalMode(b.dataset.value)));
  for (const [, prefix] of KINEMATICS) for (const axis of 'xyz') $(`${prefix}${axis}`).addEventListener('input', readCalibratorInputs);
  document.querySelectorAll('[data-cal-preset]').forEach((b) => b.addEventListener('click', () => setCalibratorPreset(b.dataset.calPreset)));
  $('cal-file').addEventListener('change', async (e) => {
    try {
      const loaded = await readFringeCalibrators([...e.target.files]);
      // The first replaces the selected calibrator, the others go after it.
      const cals = loaded.map((l, k) => {
        const cal = k ? newCalibrator() : activeCal();
        // fringe gives the state at its epoch; move it to the start of the timeline (t = 0).
        const { position: p, velocity: v, acceleration: a } = l.calibrator, t = -l.epoch;
        cal.position = { x: p.x + v.x * t + 0.5 * a.x * t * t, y: p.y + v.y * t + 0.5 * a.y * t * t, z: p.z + v.z * t + 0.5 * a.z * t * t };
        cal.velocity = { x: v.x + a.x * t, y: v.y + a.y * t, z: v.z + a.z * t };
        cal.acceleration = a;
        cal.mode = 'fixed';
        transmitter.adopt(cal.transmitter, l.transmitter, l.buffer, l.bufferName);
        return cal;
      });
      state.calibrators.splice(state.activeCal + 1, 0, ...cals.slice(1));
      renumberCalibrators();
      setCalMode('fixed');
      toast(loaded.length > 1 ? `${loaded.length} calibrators loaded as ${cals[0].name} – ${cals[cals.length - 1].name}` : `Calibrator loaded as ${cals[0].name}`, 'ok');
    } catch (err) {
      toast(`Calibrator file: ${err.message}`, 'error');
    } finally {
      e.target.value = '';
    }
  });
  $('cal-export').addEventListener('click', () => {
    const cals = state.calibrators.filter((c) => c.mode === 'fixed');
    if (!cals.length) return toast('Only kinematic calibrators can be exported, and none is on', 'error');
    const missing = cals.find((c) => !c.transmitter.buffer);
    if (missing) return toast(`${missing.name}'s transmitter has no buffer yet`, 'error');
    // Calibrators sharing a buffer share its file.
    const files = new Map();
    for (const c of cals) if (!files.has(c.transmitter.buffer)) files.set(c.transmitter.buffer, `calibrators.${files.size}.cf32`);
    download('calibrators.json', fringeCalibratorJson(cals, cals.map((c) => files.get(c.transmitter.buffer))), 'application/json');
    [...files].forEach(([buffer, name], k) => setTimeout(() => download(name, serializeCf32(buffer), 'application/octet-stream'), 300 * (k + 1)));
    const series = state.calibrators.filter((c) => c.mode === 'series').length;
    if (series) toast(`Exported the kinematic calibrators; ${series} series calibrator${series > 1 ? 's have' : ' has'} no fringe JSON form (use Series → Export)`);
  });
  $('cal-remove').addEventListener('click', removeCalibrator);
  $('tx-auto').addEventListener('click', async () => {
    await timeline.refresh();
    if (!timeline.autoPower(activeCal())) toast(`Nothing to scale: ${activeCal().name} has no position above the horizon, or its spectrum misses the band`, 'error');
  });

  // Environment toolbar
  $('view-freq').addEventListener('input', () => {
    viewFreqFromSlider();
    refreshViewFreqDependent();
    $('sky-caption').textContent = `Colour and size ∝ ${$('apparent').checked ? 'apparent' : 'intrinsic'} flux density at ${MHz(state.viewFreq)}`;
    debouncedFreqText();
  });
  $('env-cmap').addEventListener('change', (e) => {
    state.cmap = e.target.value;
    refreshViewFreqDependent();
    if (state.run) { renderPowerMap(); renderWaterfall(); }
  });
  $('apparent').addEventListener('change', () => refreshEnvironment());
  $('sky-scale').addEventListener('change', () => refreshViewFreqDependent());
  $('rotate').addEventListener('change', (e) => scene.setRotate(e.target.checked));

  // Signals
  $('antenna-index').addEventListener('change', (e) => selectAntenna(parseInt(e.target.value, 10) || 0));
  $('antenna-prev').addEventListener('click', () => selectAntenna(state.antenna - 1));
  $('antenna-next').addEventListener('click', () => selectAntenna(state.antenna + 1));

  // Imaging
  const channelChanged = debounce(() => loadImage(), 120);
  $('channel').addEventListener('input', (e) => {
    state.channel = +e.target.value;
    if (state.run) $('channel-out').textContent = MHz(state.run.channels[state.channel].frequency);
    channelChanged();
  });
  $('img-size').addEventListener('change', loadImage);
  for (const id of ['img-scale', 'img-cmap']) $(id).addEventListener('change', () => {
    const o = { cmap: $('img-cmap').value, scale: $('img-scale').value };
    dirtyImage.setOptions(o); expectedImage.setOptions(o); psfImage.setOptions({ cmap: o.cmap });
  });
  $('img-shared').addEventListener('change', () => {
    applySharedRange(dirtyImage.data?.values, expectedImage.data?.values);
  });
  $('img-overlay').addEventListener('change', () => { dirtyImage.render(); expectedImage.render(); });
}

const debouncedFreqText = debounce(() => { renderParams(); renderSourceList(); }, 150);

// ---------------------------------------------------------------------------------------
// Startup

async function init() {
  try {
    const saved = localStorage.getItem('fringe.theme');
    if (saved) document.documentElement.dataset.theme = saved;
  } catch { /* storage unavailable */ }

  populateSelects();
  // Canvases draw text with the theme's web fonts; wait briefly for them (fallbacks offline).
  const fonts = ['400 12px "IBM Plex Sans"', '400 12px "IBM Plex Mono"', '700 14px "Space Grotesk"'];
  try {
    await Promise.race([Promise.all(fonts.map((f) => document.fonts.load(f))), new Promise((r) => setTimeout(r, 1500))]);
  } catch { /* font loading API unavailable */ }
  $('env-cmap').value = state.cmap;
  $('img-cmap').value = state.cmap;
  initSidebarResize();
  bind();
  renumberCalibrators();
  transmitter = initTransmitter({
    state, api, toast, download,
    views: allViews,
    active: activeCal,
    openPython: (kind) => openPythonDialog(kind),
    onChange: () => { if (timeline) timeline.refresh(); updateStale(); },
  });
  timeline = initTimeline({
    state, api, toast, download, ask, setIntegrations, transmitter,
    active: activeCal,
    views: allViews,
    onStep: onTimelineStep,
    onChange: refreshDerived,
  });
  outputs = initOutputs({
    state, api, toast,
    views: allViews,
    integrations: integrationsCount,
    hasCalibrator,
    calibratorCount: () => enabledCals().length,
    onChange: updateRunLabel,
  });
  writeArrayInputs();
  renderCalibratorPanel();

  let info = null;
  try { info = await api('/info'); } catch (e) { toast(`Server unavailable: ${e.message}`, 'error'); }
  state.gsmAvailable = !!(info && info.gsm);
  state.python = !!(info && info.python_code);
  state.pythonDisabled = !info ? 'The server is unavailable.'
    : !('python_code' in info) ? 'The running server is older than this page; restart it (cargo run --release).'
      : info.python_code_disabled;
  $('gsm-unavailable').hidden = state.gsmAvailable;
  $('gsm-unavailable').textContent = 'The server could not find pygdsm, healpy and astropy. Install them (pip install pygdsm) or start the server with --python pointing at an interpreter that has them.';
  try {
    await loadDefaultSky();
  } catch (e) {
    setSky(M.randomSky(500, 1), '500 random sources (seed 1) — the bundled default sky could not be loaded');
    toast(e.message, 'error');
  }
  refreshEnvironment();

  try {
    const tab = localStorage.getItem('fringe.tab');
    if (tab && $(`tab-${tab}`)) showTab(tab);
  } catch { /* storage unavailable */ }

  // Reattach to a run or result that already exists on the server.
  try {
    const s = await api('/run/status');
    setStatus(s);
    if (s.state === 'running' || s.state === 'initializing') pollStatus();
    else if (s.state === 'finished' || s.state === 'cancelled') await loadResults();
  } catch { /* server unavailable; already reported */ }
  outputs.onJobFinished({ quiet: true });
  outputs.loadFiles();
}

init();
