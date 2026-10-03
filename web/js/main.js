import * as M from './model.js';
import { LinePlot, ImagePlot, COLORMAPS, si, fmt } from './plot.js';
import { SceneView, ArrayView, SkyView } from './views.js';
import { CodeEditor } from './editor.js';
import { LAYOUT_EXAMPLES } from './layouts.js';

const $ = (id) => document.getElementById(id);
const MHz = (f) => `${+(f / 1e6).toFixed(3)} MHz`;
const DEG = 180 / Math.PI;

// ---------------------------------------------------------------------------------------
// State

const state = {
  array: M.defaultArray(),
  sources: [],
  calibrator: { enabled: false, position: { x: 62, y: 62, z: 150 }, intensity: 1e12 },
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
  pythonLayout: false,
  pythonLayoutDisabled: null,
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
  xLabel: 'frequency (MHz)', yLabel: 'power per bin', yLog: true, yFloorRatio: 1e5, empty: 'No bandpass',
});
const powerMap = new ArrayView($('power-map'), { onSelect: (i) => selectAntenna(i) });
const tsPlot = new LinePlot($('timeseries'), { xLabel: 'time (µs)', yLabel: 'amplitude' });
const specPlot = new LinePlot($('spectrum'), { xLabel: 'frequency (MHz)', yLabel: 'power per bin', yLog: true, yFloorRatio: 1e4 });
const histPlot = new LinePlot($('histogram'), { xLabel: 'sample value', yLabel: 'probability density', yZero: true });
const waterfall = new ImagePlot($('waterfall'), {
  scale: 'log', robust: true, xLabel: 'frequency (MHz)', yLabel: 'integration', cbLabel: 'power (dB)', yFormat: (v) => fmt(v, 3),
});
const imgOpts = { sky: true, xLabel: 'l', yLabel: 'm', cbLabel: 'apparent intensity', hoverExtra: directionTip };
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
}

function readArrayInputs() {
  const a = state.array;
  a.sample_frequency = parseFloat($('fs').value) * 1e6;
  a.downmix_frequency = parseFloat($('fdown').value) * 1e6;
  a.bandpass = [parseFloat($('bp-min').value) * 1e6, parseFloat($('bp-max').value) * 1e6];
  a.sample_window_size = parseInt($('window-size').value, 10);
  a.system_noise_intensity = parseFloat($('noise').value);
  envChanged();
}

function writeCalibratorInputs() {
  const c = state.calibrator;
  $('cal-enabled').checked = c.enabled;
  $('cal-x').value = c.position.x; $('cal-y').value = c.position.y; $('cal-z').value = c.position.z;
  $('cal-i').value = c.intensity;
}

function readCalibratorInputs() {
  const c = state.calibrator;
  c.enabled = $('cal-enabled').checked;
  c.position = { x: parseFloat($('cal-x').value) || 0, y: parseFloat($('cal-y').value) || 0, z: parseFloat($('cal-z').value) || 0 };
  c.intensity = Math.max(0, parseFloat($('cal-i').value) || 0);
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
    fetch('data/default_sky.csv').then((r) => { if (!r.ok) throw new Error('default sky model unavailable'); return r.text(); }),
    fetch('data/default_sky.json').then((r) => (r.ok ? r.json() : null)).catch(() => null),
  ]);
  const epoch = meta && meta.epoch_utc ? ` at ${meta.epoch_utc.replace('T', ' ').replace(/:00(\.000)?$/, '')} UTC` : '';
  setSky(M.parseSourcesCsv(csv), meta
    ? `Default: GSM2016, NSIDE ${meta.nside}, lunar far side${epoch}, α fitted over ${meta.map_frequencies.length} maps`
    : 'Default sky model');
}

function setCalibratorPreset(kind) {
  const c = M.centroid(state.array.antenna_positions);
  const cal = state.calibrator;
  if (kind === 'drone') cal.position = { x: +c.x.toFixed(2), y: +c.y.toFixed(2), z: 150 };
  else {
    const d = 550e3, el = 60 / DEG, az = 30 / DEG;
    cal.position = { x: Math.round(c.x + d * Math.cos(el) * Math.cos(az)), y: Math.round(c.y + d * Math.cos(el) * Math.sin(az)), z: Math.round(d * Math.sin(el)) };
  }
  // Pick an intensity that puts the calibrator at the level of sky + noise at band centre.
  const f = (M.physicalBand(state.array)[0] + M.physicalBand(state.array)[1]) / 2;
  const m = M.modelSpectrum(state.array, state.sources, { enabled: false }, [f]);
  const unit = M.meanCalibratorPower({ enabled: true, position: cal.position, intensity: 1 }, state.array.antenna_positions);
  if (unit > 0 && Number.isFinite(m.total[0])) cal.intensity = +(m.total[0] / unit).toPrecision(3);
  cal.enabled = true;
  writeCalibratorInputs();
  envChanged();
}

function renderSourceList() {
  const f = state.viewFreq;
  const top = state.sources
    .map((s) => ({ s, v: M.sourceIntensity(s, f) * M.sourceGain(s) }))
    .sort((a, b) => b.v - a.v)
    .slice(0, 6);
  const el = $('source-list');
  if (!top.length) { el.innerHTML = '<p class="note">No sources. The simulation will contain system noise (and the calibrator) only.</p>'; return; }
  el.innerHTML = `<div class="head">Brightest (apparent at ${MHz(f)})</div>
    <table><tr><th>RA°</th><th>Dec°</th><th>I(f)</th><th>α</th><th></th></tr>
    ${top.map(({ s, v }, i) => `<tr><td>${(s.ra * DEG).toFixed(1)}</td><td>${(s.dec * DEG).toFixed(1)}</td><td>${fmt(v, 3)}</td><td>${s.alpha.toFixed(2)}</td><td><button class="rm" data-i="${i}" title="Remove source" aria-label="Remove source">×</button></td></tr>`).join('')}
    </table>`;
  el.querySelectorAll('.rm').forEach((b) => b.addEventListener('click', () => {
    const target = top[+b.dataset.i].s;
    setSky(state.sources.filter((s) => s !== target), editedOrigin());
  }));
}

// ---------------------------------------------------------------------------------------
// Python array layouts (run server-side with the user's Python)

const py = { editor: null, preview: null, positions: null, running: false };

function openPythonDialog() {
  if (!py.editor) initPythonDialog();
  $('py-dialog').showModal();
  py.editor.ta.focus();
  if (!py.positions && state.pythonLayout) runPythonLayout();
  else renderPythonPreview(py.positions || state.array.antenna_positions, !py.positions);
}

function initPythonDialog() {
  let saved = null;
  try { saved = localStorage.getItem('fringe.layoutCode'); } catch { /* storage unavailable */ }
  const save = debounce((code) => { try { localStorage.setItem('fringe.layoutCode', code); } catch { /* storage unavailable */ } }, 300);
  py.editor = new CodeEditor($('py-editor'), { value: saved || LAYOUT_EXAMPLES[0].code, onRun: runPythonLayout, onChange: save });
  py.preview = new ArrayView($('py-preview'));
  allViews.push(py.preview);
  LAYOUT_EXAMPLES.forEach((ex, i) => $('py-example').add(new Option(ex.name, String(i))));
  $('py-example').addEventListener('change', (e) => {
    if (e.target.value === '') return;
    py.editor.setValue(LAYOUT_EXAMPLES[+e.target.value].code); // undoable with Ctrl+Z
    e.target.value = '';
  });
  $('py-run').addEventListener('click', runPythonLayout);
  $('py-apply').addEventListener('click', applyPythonLayout);
  $('py-close').addEventListener('click', () => $('py-dialog').close());
  if (!state.pythonLayout) {
    $('py-run').disabled = true;
    pyConsole([[state.pythonLayoutDisabled || 'Python layouts are unavailable on this server.', 'err']]);
  } else {
    pyConsole([['Press Run (Ctrl+Enter) to execute layout(ctx).', 'muted']]);
  }
}

function pyConsole(parts) {
  const el = $('py-console');
  el.innerHTML = '';
  for (const [text, cls] of parts) {
    const span = document.createElement('span');
    if (cls) span.className = cls;
    span.textContent = text.endsWith('\n') ? text : text + '\n';
    el.appendChild(span);
  }
  el.scrollTop = el.scrollHeight;
}

function pythonContext() {
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
}

async function runPythonLayout() {
  if (py.running || !state.pythonLayout) return;
  py.running = true;
  $('py-run').disabled = true;
  $('py-run').textContent = 'Running…';
  try {
    const res = await api('/array/python', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: py.editor.value, context: pythonContext() }),
    });
    const parts = res.stdout ? [[res.stdout, '']] : [];
    if (res.error) {
      py.positions = null;
      parts.push([res.error, 'err']);
      const shown = $('py-stats').querySelector('dd');
      if (shown && shown.textContent === 'layout() result') shown.textContent = 'last successful result';
    } else {
      py.positions = res.positions.map(([x, y, z]) => ({ x, y, z }));
      parts.push([`✓ layout() returned ${py.positions.length.toLocaleString()} antennas in ${si(res.elapsed_s, 3, 's')}`, 'ok']);
      renderPythonPreview(py.positions, false);
    }
    pyConsole(parts);
  } catch (e) {
    py.positions = null;
    pyConsole([[e.message, 'err']]);
  } finally {
    py.running = false;
    $('py-run').disabled = false;
    $('py-run').textContent = '▶ Run';
    $('py-apply').disabled = !py.positions;
  }
}

function renderPythonPreview(positions, isCurrent) {
  py.preview.set({ positions, calibrator: null });
  const s = M.arrayStats(positions);
  const [, fmax] = M.physicalBand(state.array);
  const halfLambda = M.C / fmax / 2;
  const rows = [
    ['Showing', isCurrent ? 'current array' : 'layout() result'],
    ['Antennas', `${s.n.toLocaleString()}${isCurrent ? '' : ` (current: ${state.array.antenna_positions.length.toLocaleString()})`}`],
    ['Extent', `${si(s.maxX - s.minX, 3, 'm')} × ${si(s.maxY - s.minY, 3, 'm')}`],
    ['Longest baseline', si(s.maxBaseline, 4, 'm')],
  ];
  if (Number.isFinite(s.minSpacing)) {
    if (s.minSpacing === 0) rows.push(['Min. spacing', 'coincident antennas', 'warn']);
    else if (s.minSpacing > halfLambda) rows.push(['Min. spacing', `${si(s.minSpacing, 3, 'm')} · grating lobes above ${MHz(M.C / (2 * s.minSpacing))}`, 'warn']);
    else rows.push(['Min. spacing', `${si(s.minSpacing, 3, 'm')} (≤ λ_min/2 = ${si(halfLambda, 3, 'm')})`]);
  }
  rows.push(['Geometry', s.planar ? 'planar' : `non-planar (Δz ${si(s.maxZ - s.minZ, 3, 'm')})`]);
  $('py-stats').innerHTML = `<dl>${rows.map(([k, v, cls]) => `<dt>${k}</dt><dd class="${cls || ''}">${v}</dd>`).join('')}</dl>`;
}

function applyPythonLayout() {
  if (!py.positions) return;
  state.array.antenna_positions = py.positions;
  state.antenna = 0;
  envChanged();
  $('py-dialog').close();
  toast(`Array layout set from Python: ${py.positions.length.toLocaleString()} antennas`, 'ok');
}

// ---------------------------------------------------------------------------------------
// GSM2016 sky models (generated server-side with PyGDSM)

function gsmParams() {
  const [lo, hi] = M.physicalBand(state.array);
  const mhz = (id) => parseFloat($(id).value) * 1e6;
  return {
    nside: parseInt($('gsm-nside').value, 10),
    maps: parseInt($('gsm-maps').value, 10),
    fmin: mhz('gsm-fmin') || Math.max(10e6, lo),
    fmax: mhz('gsm-fmax') || hi,
    frame: $('gsm-frame').value,
    epoch: gsmEpoch(),
    resolution: $('gsm-resolution').value,
    above_horizon: $('gsm-horizon').checked,
  };
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
    'MJy/sr × pixel solid angle → Jy per source, power law fitted per pixel around the geometric-mean frequency. ' +
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
        `f_ref ${MHz(summary.reference_frequency)} · α median ${fmt(a50, 3)} (1–99%: ${fmt(a1, 3)} … ${fmt(a99, 3)}) · ` +
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
  $('cal-badge').textContent = state.calibrator.enabled ? 'on' : 'off';
  $('array-caption').textContent = `${a.antenna_positions.length} antennas · ${si(stats.maxX - stats.minX, 3, 'm')} × ${si(stats.maxY - stats.minY, 3, 'm')}`;
  $('sky-caption').textContent = `Colour and size ∝ ${$('apparent').checked ? 'apparent' : 'intrinsic'} intensity at ${MHz(state.viewFreq)}`;

  renderSourceList();
  renderGsmNote();
  refreshViewFreqDependent();
  if (!err) renderModelSpectrum();
  renderParams();
  renderWorkload();
  updateStale();
}

/** Views that depend on the view frequency (cheap ones redraw immediately). */
function refreshViewFreqDependent() {
  const env = {
    positions: state.array.antenna_positions,
    sources: state.sources,
    calibrator: state.calibrator,
    freq: state.viewFreq,
    cmap: state.cmap,
    scale: $('sky-scale').value,
  };
  scene.set(env);
  arrayView.set({ positions: env.positions, calibrator: env.calibrator });
  skyView.set({ ...env, apparent: $('apparent').checked });
  modelPlot.vlines = [{ x: state.viewFreq / 1e6, label: 'view' }];
  modelPlot.render();
  requestBeam();
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

function bandFreqs(array, n = 700) {
  const lo = array.downmix_frequency, hi = array.downmix_frequency + array.sample_frequency / 2;
  const f = new Float64Array(n);
  for (let i = 0; i < n; i++) f[i] = lo + ((i + 0.5) / n) * (hi - lo);
  // Make sure the band edges are sampled exactly so the model doesn't look clipped.
  return Float64Array.from([...f, ...M.physicalBand(array)]).sort();
}

function renderModelSpectrum() {
  const a = state.array;
  const f = bandFreqs(a);
  const m = M.modelSpectrum(a, state.sources, state.calibrator, f);
  const x = Array.from(f, (v) => v / 1e6);
  const series = [
    { label: 'Total', x, y: m.total, color: 'fg', width: 2 },
    { label: 'Sky sources', x, y: m.sky, color: 's1' },
    { label: 'System noise', x, y: m.noise, color: 's2' },
  ];
  if (state.calibrator.enabled) series.push({ label: 'Calibrator (array mean)', x, y: m.cal, color: 's3' });
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
  const above = state.sources.filter((x) => x.z > 0).length;
  const m = M.modelSpectrum(a, state.sources, state.calibrator, [state.viewFreq]);
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
    [`Sky at ${MHz(state.viewFreq)}`, [
      ['Sources (above horizon)', `${state.sources.length} (${above})`],
      ['Apparent sky power', fmt(m.sky[0], 4)],
      ['System noise power', fmt(m.noise[0], 4)],
      ['A_eff (noise)', `${fmt(M.effectiveAperture(state.viewFreq), 3)} m²`],
      ['Sky / noise', `${fmt(m.sky[0] / m.noise[0], 3)}`],
      ...(state.calibrator.enabled ? calibratorRows(m) : []),
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

function calibratorRows(m) {
  const c = state.calibrator, ctr = M.centroid(state.array.antenna_positions);
  const d = [c.position.x - ctr.x, c.position.y - ctr.y, c.position.z - ctr.z];
  const dist = Math.hypot(...d);
  return [
    ['Calibrator distance', si(dist, 4, 'm')],
    ['Calibrator elevation', `${(Math.asin(d[2] / dist) * DEG).toFixed(1)}°`],
    ['Calibrator power (mean)', `${fmt(m.cal[0], 4)}`],
  ];
}

function workloadTerms() {
  const a = state.array;
  const R = +$('freq-res').value;
  const fine = Math.max(0, ((a.bandpass[1] - a.bandpass[0]) * a.sample_window_size * R) / a.sample_frequency);
  return a.antenna_positions.length * (state.sources.length + 2) * fine;
}

function renderWorkload() {
  const terms = workloadTerms();
  const n = parseInt($('integrations').value, 10) || 1;
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

function buildRequest() {
  let seed = $('seed').value.trim();
  const rng_seed = seed === '' ? Math.floor(Math.random() * 2 ** 32) : Number(seed);
  return {
    runtime: state.runtime,
    frequency_resolution: +$('freq-res').value,
    rng_seed,
    integrations: parseInt($('integrations').value, 10),
    array: state.array,
    sources: state.sources.map((s) => ({
      right_ascension: s.ra, declination: s.dec, reference_frequency: s.f0, reference_intensity: s.I0, spectral_index: s.alpha,
    })),
    calibrator: state.calibrator.enabled ? { position: state.calibrator.position, intensity: state.calibrator.intensity } : null,
    analysis: { window: $('window-fn').value, channels: parseInt($('channels').value, 10) },
  };
}

/** Identity of the configuration that affects results (seed excluded when random). */
function configKey() {
  const r = buildRequest();
  if ($('seed').value.trim() === '') r.rng_seed = 'random';
  return JSON.stringify(r);
}

async function startRun() {
  const request = buildRequest();
  try {
    const { run_id } = await api('/run', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request),
    });
    state.activeRunId = run_id;
    state.pendingSnapshot = {
      key: configKey(),
      sources: state.sources.slice(),
      calibrator: structuredClone(state.calibrator),
      terms: workloadTerms(),
      runtime: state.runtime,
    };
    setStatus({ state: 'initializing', completed: 0, total: request.integrations, elapsed_s: 0 });
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
    running: `Simulating · window ${s.completed}/${s.total} · ${elapsed}`,
    finished: `Finished · ${s.completed} windows in ${elapsed}`,
    cancelled: `Cancelled after ${s.completed}/${s.total} windows`,
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
    toast(`Simulation ${s.state} — ${s.completed} windows. See Signals and Imaging.`, 'ok');
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
function runCalibrator() { return state.snapshot ? state.snapshot.calibrator : state.calibrator; }

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
    ['Total time', si(r.timing.total_s, 3, 's'), `${r.sources} sources${r.calibrator ? ' + calibrator' : ''}`],
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
    positions: r.array.antenna_positions, calibrator: runCalibrator(), values: r.antenna_power, selected: state.antenna, cmap: state.cmap,
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
  const f = bandFreqs(a, 400);
  const sources = runSources(), cal = runCalibrator();
  const m = M.modelSpectrum(a, sources, { enabled: false }, f);
  const calP = cal && cal.enabled && r.calibrator ? M.calibratorPower(cal, d.position) : 0;
  const model = Array.from(m.total, (v) => v + calP);
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
  const mf = M.modelSpectrum(a, sources, cal && r.calibrator ? cal : { enabled: false }, x.slice(i0, i1 + 1).map((v) => v * 1e6));
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
  const cal = runCalibrator();
  if (cal && cal.enabled && state.run.calibrator) {
    const c = M.centroid(state.run.array.antenna_positions);
    const d = [cal.position.x - c.x, cal.position.y - c.y, cal.position.z - c.z];
    const n = Math.hypot(...d);
    if (d[2] > 0) {
      const [x, y] = toPx(d[0] / n, d[1] / n);
      ctx.strokeStyle = t.s3; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(x, y - 8); ctx.lineTo(x + 7, y); ctx.lineTo(x, y + 8); ctx.lineTo(x - 7, y); ctx.closePath(); ctx.stroke();
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
  const sources = runSources().map(({ x, y, z, f0, I0, alpha }) => ({ x, y, z, f0, I0, alpha }));
  // The calibrator enters as a far-field point source in its direction from the array centre,
  // carrying the mean per-antenna power (exact for distant emitters such as satellites).
  const cal = runCalibrator();
  if (cal && cal.enabled && r.calibrator) {
    const c = M.centroid(r.array.antenna_positions);
    const d = [cal.position.x - c.x, cal.position.y - c.y, cal.position.z - c.z];
    const n = Math.hypot(...d);
    const z = d[2] / n;
    const power = M.meanCalibratorPower(cal, r.array.antenna_positions);
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
  if (name !== 'environment') $(`${name}-dot`).hidden = true;
  try { localStorage.setItem('fringe.tab', name); } catch { /* storage unavailable */ }
}

function applyTheme(theme) {
  if (theme) document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
  allViews.forEach((v) => v.render());
  [modelPlot, tsPlot, specPlot, histPlot].forEach((p) => p.renderLegend());
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
  for (const id of ['freq-res', 'integrations', 'seed', 'window-fn', 'channels']) {
    $(id).addEventListener('input', () => { renderParams(); renderWorkload(); updateStale(); });
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
  $('array-python').addEventListener('click', openPythonDialog);
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
  for (const id of ['gsm-nside', 'gsm-maps', 'gsm-frame', 'gsm-epoch', 'gsm-fmin', 'gsm-fmax', 'gsm-resolution', 'gsm-horizon']) {
    $(id).addEventListener('input', renderGsmNote);
  }
  $('gsm-replace').addEventListener('click', () => generateGsm(false));
  $('gsm-append').addEventListener('click', () => generateGsm(true));
  $('src-add').addEventListener('click', () => {
    const v = (id) => parseFloat($(id).value);
    if (!(v('src-f0') > 0) || !(v('src-i') >= 0)) return toast('Source needs f₀ > 0 and I₀ ≥ 0', 'error');
    setSky(state.sources.concat([M.makeSource(v('src-ra') / DEG, v('src-dec') / DEG, v('src-f0') * 1e6, v('src-i'), v('src-alpha') || 0)]), editedOrigin());
  });

  // Calibrator
  for (const id of ['cal-enabled', 'cal-x', 'cal-y', 'cal-z', 'cal-i']) $(id).addEventListener('input', readCalibratorInputs);
  document.querySelectorAll('[data-cal-preset]').forEach((b) => b.addEventListener('click', () => setCalibratorPreset(b.dataset.calPreset)));
  $('cal-file').addEventListener('change', async (e) => {
    try { state.calibrator = M.parseCalibratorJson(await readFile(e.target)); writeCalibratorInputs(); envChanged(); toast('Calibrator loaded'); } catch (err) { toast(`Calibrator file: ${err.message}`, 'error'); }
  });
  $('cal-export').addEventListener('click', () => download('calibrator.json', M.serializeCalibrator(state.calibrator), 'application/json'));

  // Environment toolbar
  $('view-freq').addEventListener('input', () => {
    viewFreqFromSlider();
    refreshViewFreqDependent();
    $('sky-caption').textContent = `Colour and size ∝ ${$('apparent').checked ? 'apparent' : 'intrinsic'} intensity at ${MHz(state.viewFreq)}`;
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
  $('env-cmap').value = state.cmap;
  $('img-cmap').value = 'plasma';
  bind();
  writeArrayInputs();
  writeCalibratorInputs();

  let info = null;
  try { info = await api('/info'); } catch (e) { toast(`Server unavailable: ${e.message}`, 'error'); }
  state.gsmAvailable = !!(info && info.gsm);
  state.pythonLayout = !!(info && info.python_layout);
  state.pythonLayoutDisabled = info ? info.python_layout_disabled : 'The server is unavailable.';
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
}

init();
