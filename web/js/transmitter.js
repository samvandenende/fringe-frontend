// Calibrator transmitters, configured like fringe's Transmitter (a software defined radio): a
// carrier frequency, a cyclic buffer of complex baseband samples played out at a sample rate, the
// equivalent isotropically radiated power (W; fringe scales the buffer to it whatever its RMS), an
// optional reconstruction filter bandwidth and the time of the first buffer sample. Buffers are generated here (or loaded, or computed by Python) and
// sent to the server as base64 cf32, so the spectrum model below sees exactly what fringe plays.
import * as M from './model.js';
import { LinePlot, fmt, si } from './plot.js';
import { TRANSMITTER_EXAMPLES } from './calibrators.js';

const $ = (id) => document.getElementById(id);
const MHz = (f) => `${+(f / 1e6).toFixed(4)} MHz`;
/** fringe oversamples buffers 16× up to 2^30 samples; the server accepts up to 2^22. */
export const MAX_BUFFER_SAMPLES = 1 << 22;

/**
 * Feedback taps of maximal-length Fibonacci LFSRs (bit positions counted from the output end),
 * one primitive polynomial per degree: the sequences repeat every 2^degree − 1 chips.
 */
const LFSR_TAPS = {
  5: [5, 3], 6: [6, 5], 7: [7, 6], 8: [8, 6, 5, 4], 9: [9, 5], 10: [10, 7], 11: [11, 9], 12: [12, 6, 4, 1],
  13: [13, 4, 3, 1], 14: [14, 5, 3, 1], 15: [15, 14], 16: [16, 15, 13, 4], 17: [17, 14], 18: [18, 11],
  19: [19, 6, 2, 1], 20: [20, 17], 21: [21, 19], 22: [22, 21],
};
export const PRN_DEGREES = Object.keys(LFSR_TAPS).map(Number);

// ---------------------------------------------------------------------------------------
// Buffers (interleaved I/Q Float32Arrays)

/** BPSK chips (±1) of the m-sequence of a degree. */
export function mSequence(degree) {
  const taps = LFSR_TAPS[degree];
  const n = 2 ** degree - 1;
  const out = new Int8Array(n);
  let s = n; // all ones
  for (let i = 0; i < n; i++) {
    out[i] = s & 1 ? -1 : 1;
    let fb = 0;
    for (const t of taps) fb ^= (s >>> (degree - t)) & 1;
    s = (s >>> 1) | (fb << (degree - 1));
  }
  return out;
}

/** Generated buffer of a waveform kind, with unit RMS. */
export function generate(kind, { length = 65536, seed = 1, degree = 12 } = {}) {
  if (kind === 'tone') return Float32Array.of(1, 0);
  if (kind === 'prn') {
    const chips = mSequence(degree);
    const iq = new Float32Array(2 * chips.length);
    for (let i = 0; i < chips.length; i++) iq[2 * i] = chips[i];
    return iq;
  }
  const n = Math.max(1, Math.min(MAX_BUFFER_SAMPLES, Math.round(length)));
  const iq = new Float32Array(2 * n);
  if (kind === 'chirp') {
    // Linear sweep from −rate/2 to +rate/2 over one buffer period, continuous when it wraps.
    for (let i = 0; i < n; i++) {
      const phase = Math.PI * (((i * i) % (2 * n)) / n - i);
      iq[2 * i] = Math.cos(phase); iq[2 * i + 1] = Math.sin(phase);
    }
    return iq;
  }
  // Complex Gaussian white noise (Box–Muller), E|x|² = 1.
  const rnd = M.mulberry32(seed);
  for (let i = 0; i < n; i++) {
    const r = Math.sqrt(-Math.log(1 - rnd())), t = 2 * Math.PI * rnd();
    iq[2 * i] = r * Math.cos(t); iq[2 * i + 1] = r * Math.sin(t);
  }
  return iq;
}

/** Mean |x|² of a buffer. */
export function meanPower(iq) {
  let s = 0;
  for (let i = 0; i < iq.length; i++) s += iq[i] * iq[i];
  return s / (iq.length / 2);
}

/** Raw interleaved little-endian float32 IQ (cf32_le), as fringe's buffer files. */
export function parseCf32(bytes) {
  if (bytes.byteLength % 8) throw new Error('a cf32 file holds 8 bytes per sample (I and Q as float32)');
  const n = bytes.byteLength / 4;
  if (!n) throw new Error('the file is empty');
  if (n / 2 > MAX_BUFFER_SAMPLES) throw new Error(`at most ${MAX_BUFFER_SAMPLES.toLocaleString()} samples are supported`);
  const view = new DataView(bytes);
  const iq = new Float32Array(n);
  for (let i = 0; i < n; i++) iq[i] = view.getFloat32(4 * i, true);
  if (!iq.every(Number.isFinite)) throw new Error('the file has non-finite samples');
  if (!iq.some((v) => v !== 0)) throw new Error('the buffer is all zeros');
  return iq;
}

export function serializeCf32(iq) {
  const view = new DataView(new ArrayBuffer(iq.length * 4));
  for (let i = 0; i < iq.length; i++) view.setFloat32(4 * i, iq[i], true);
  return view.buffer;
}

export function toBase64(bytes) {
  const u8 = new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}

export function fromBase64(text) {
  const s = atob(text);
  const u8 = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
  return u8.buffer;
}

// ---------------------------------------------------------------------------------------
// Spectrum

/** Power of each DFT line of a buffer, |X_k|² / L², summing to its mean power (Bluestein for any length). */
export function linePowers(iq) {
  const L = iq.length / 2;
  const out = new Float64Array(L);
  if ((L & (L - 1)) === 0) {
    const re = new Float64Array(L), im = new Float64Array(L);
    for (let i = 0; i < L; i++) { re[i] = iq[2 * i]; im[i] = iq[2 * i + 1]; }
    M.fft(re, im);
    for (let k = 0; k < L; k++) out[k] = (re[k] * re[k] + im[k] * im[k]) / (L * L);
    return out;
  }
  let N = 1;
  while (N < 2 * L - 1) N <<= 1;
  const wr = new Float64Array(L), wi = new Float64Array(L);
  for (let n = 0; n < L; n++) {
    const a = (-Math.PI * ((n * n) % (2 * L))) / L; // n² mod 2L keeps the angle exact
    wr[n] = Math.cos(a); wi[n] = Math.sin(a);
  }
  const ar = new Float64Array(N), ai = new Float64Array(N), br = new Float64Array(N), bi = new Float64Array(N);
  for (let n = 0; n < L; n++) {
    const xr = iq[2 * n], xi = iq[2 * n + 1];
    ar[n] = xr * wr[n] - xi * wi[n]; ai[n] = xr * wi[n] + xi * wr[n];
    br[n] = wr[n]; bi[n] = -wi[n];
    if (n) { br[N - n] = wr[n]; bi[N - n] = -wi[n]; }
  }
  M.fft(ar, ai); M.fft(br, bi);
  for (let k = 0; k < N; k++) {
    const r = ar[k] * br[k] - ai[k] * bi[k];
    ai[k] = ar[k] * bi[k] + ai[k] * br[k]; ar[k] = r;
  }
  M.fft(ar, ai, true);
  for (let k = 0; k < L; k++) {
    const cr = ar[k] / N, ci = ai[k] / N;
    const xr = cr * wr[k] - ci * wi[k], xi = cr * wi[k] + ci * wr[k];
    out[k] = (xr * xr + xi * xi) / (L * L);
  }
  return out;
}

/** Baseband frequencies (Hz) between which the middle 99% of a buffer's power lies. */
export function occupiedBand(lines, sampleRate) {
  const L = lines.length;
  if (L === 1) return [0, 0];
  let total = 0;
  for (let k = 0; k < L; k++) total += lines[k];
  const h = Math.floor(L / 2);
  let acc = 0, lo = null, hi = null;
  for (let j = 0; j < L; j++) {
    const k = (j - h + L) % L; // from the most negative frequency upwards
    acc += lines[k];
    if (lo === null && acc >= 0.005 * total) lo = j - h;
    if (hi === null && acc >= 0.995 * total) hi = j - h;
  }
  return [(lo * sampleRate) / L, (hi * sampleRate) / L];
}

/**
 * Received spectral shape on the analysis channels (width fs/W): `at(f)` turns the delivered power
 * flux density (W/m², model.js calibratorPower) into per-bin power in Jy at physical frequency f.
 * fringe scales the buffer to unit mean power (so the transmitter radiates its EIRP), then removes
 * the lines outside the transmitter bandwidth or the array's bandpass, so those lose power; the
 * Doppler shift is ignored. A buffer that is white over the array's sample frequency fs is received
 * like a sky source of G·P / (4π d² fs) / 1e-26 Jy. Each channel is spread over its neighbours like a Hann-windowed
 * tone (2/3, 1/6, 1/6), which keeps noise levels and gives the peak of a tone.
 */
export function receivedShape(tx, lines, array) {
  const fs = array.sample_frequency, W = array.sample_window_size, df = fs / W;
  const L = lines.length, r = tx.sampleRate, fdm = array.downmix_frequency;
  const [bp0, bp1] = array.bandpass;
  const raw = new Float64Array(W);
  let total = 0, passed = 0;
  for (let k = 0; k < L; k++) {
    const p = lines[k];
    total += p;
    if (!p) continue;
    const fb = ((k <= (L - 1) / 2 ? k : k - L) * r) / L;
    if (tx.bandwidth && Math.abs(fb) > tx.bandwidth / 2) continue;
    const frx = fb + tx.frequency - fdm;
    if (frx < bp0 || frx > bp1) continue;
    passed += p;
    raw[((Math.round(frx / df) % W) + W) % W] += p;
  }
  const values = new Float64Array(W);
  let peak = 0;
  // Power fraction per channel of width df, as flux density: W/m² spread over df Hz, in Jy.
  const scale = total > 0 ? 1 / (total * df * M.JANSKY) : 0;
  for (let c = 0; c < W; c++) {
    values[c] = scale * ((2 / 3) * raw[c] + (raw[(c + W - 1) % W] + raw[(c + 1) % W]) / 6);
    if (values[c] > values[peak]) peak = c;
  }
  const at = (f) => {
    const c = Math.round((f - fdm) / df);
    return c >= 0 && c < W ? values[c] : 0;
  };
  // Reference frequency for comparisons with the sky: the carrier, unless it carries little power.
  const peakFreq = peak * df + fdm;
  const refFreq = values[peak] > 0 && at(tx.frequency) >= 0.25 * values[peak] ? tx.frequency : peakFreq;
  return { at, values, df, fdm, total, passed, refFreq, peak: values[peak] };
}

// ---------------------------------------------------------------------------------------
// fringe's calibrators JSON (a list, with buffers in cf32 files next to it)

/** fringe calibrators JSON for kinematic calibrators [{ position, velocity, acceleration, transmitter }]. */
export function fringeCalibratorJson(calibrators, bufferFiles) {
  return JSON.stringify(calibrators.map((cal, k) => {
    const tx = cal.transmitter;
    const entry = {
      position: cal.position, velocity: cal.velocity, acceleration: cal.acceleration, epoch: 0,
      transmitter: { frequency: tx.frequency, sample_rate: tx.sampleRate, power: tx.power, start_time: tx.startTime, buffer: bufferFiles[k] },
    };
    if (tx.bandwidth) entry.transmitter.bandwidth = tx.bandwidth;
    return entry;
  }), null, 2);
}

/** The calibrators of a calibrators JSON file, each with its buffer from the matching cf32 file. */
export async function readFringeCalibrators(files) {
  const json = files.find((f) => /\.json$/i.test(f.name));
  if (!json) throw new Error('select the calibrators .json file (and its .cf32 buffer files)');
  let list = JSON.parse(await json.text());
  if (!Array.isArray(list)) list = [list];
  if (!list.length) throw new Error('the file lists no calibrators');
  const cf32 = files.filter((f) => /\.cf32$/i.test(f.name));
  const buffers = new Map();
  const vec = (v) => ({ x: +(v?.x ?? 0), y: +(v?.y ?? 0), z: +(v?.z ?? 0) });
  const out = [];
  for (const [k, c] of list.entries()) {
    if (!c.position || !c.transmitter) {
      throw new Error('expected fringe calibrators JSON: [{ position, velocity?, acceleration?, transmitter: { frequency, sample_rate, power, buffer } }]');
    }
    const t = c.transmitter;
    const name = String(t.buffer || '').split(/[\\/]/).pop();
    const bin = files.find((f) => f.name === name) || (list.length === 1 && cf32.length === 1 ? cf32[0] : null);
    if (!bin) throw new Error(`calibrator ${k + 1}: also select the buffer file ${name || '(.cf32)'} named in the JSON`);
    if (!buffers.has(bin)) buffers.set(bin, parseCf32(await bin.arrayBuffer()));
    out.push({
      calibrator: { position: vec(c.position), velocity: vec(c.velocity), acceleration: vec(c.acceleration) },
      epoch: +(c.epoch || 0),
      transmitter: {
        frequency: +t.frequency, sampleRate: +t.sample_rate, power: +t.power,
        bandwidth: t.bandwidth ? +t.bandwidth : null, startTime: +(t.start_time || 0),
      },
      buffer: buffers.get(bin),
      bufferName: bin.name,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------------------
// Sidebar controls

let nextBufferId = 1;

/** Settings of a new transmitter (generate() fills in the buffer). */
export function newTransmitter(overrides = {}) {
  const tx = {
    frequency: 30e6, sampleRate: 30e6, power: 1e-5, bandwidth: null, startTime: 0,
    waveform: 'noise', length: 65536, seed: 1, degree: 12, buffer: null, source: '', id: 0, pythonBuffer: null,
    ...overrides,
  };
  if (!tx.buffer && ['noise', 'prn', 'chirp', 'tone'].includes(tx.waveform)) {
    tx.buffer = generate(tx.waveform, tx);
    tx.source = tx.waveform;
  }
  tx.id = nextBufferId++;
  return tx;
}

/**
 * ctx: { state, api, toast, download, views, active() → the selected calibrator, openPython(kind),
 *   onChange() }
 * Each calibrator has a transmitter: { frequency, sampleRate, power, bandwidth, startTime, waveform,
 *   length, seed, degree, buffer, source, id, pythonBuffer }. The controls edit the selected
 *   calibrator's; shape(), dto() etc. take any transmitter (the selected one by default).
 */
export function initTransmitter(ctx) {
  const { state, toast } = ctx;
  const active = () => ctx.active().transmitter;
  // Per-transmitter caches of the line powers, received shape and base64 buffer.
  const caches = new WeakMap();
  const cacheOf = (tx) => {
    let c = caches.get(tx);
    if (!c) caches.set(tx, (c = { lines: { id: -1, lines: null }, shape: { key: '', shape: null }, b64: { id: -1, text: '' } }));
    return c;
  };

  const num = (id) => parseFloat($(id).value);

  function write() {
    const tx = active();
    $('tx-freq').value = +(tx.frequency / 1e6).toPrecision(10);
    $('tx-rate').value = +(tx.sampleRate / 1e6).toPrecision(10);
    $('tx-power').value = tx.power;
    $('tx-bw').value = tx.bandwidth ? +(tx.bandwidth / 1e6).toPrecision(10) : '';
    $('tx-start').value = tx.startTime || '';
    $('tx-wave').value = tx.waveform;
    $('tx-length').value = tx.length;
    $('tx-seed').value = tx.seed;
    $('tx-degree').value = tx.degree;
    renderControls();
    renderSummary();
  }

  function read() {
    const tx = active();
    if (num('tx-freq') >= 0) tx.frequency = num('tx-freq') * 1e6;
    if (num('tx-rate') > 0) tx.sampleRate = num('tx-rate') * 1e6;
    tx.power = Math.max(0, num('tx-power') || 0);
    tx.bandwidth = num('tx-bw') > 0 ? num('tx-bw') * 1e6 : null;
    tx.startTime = Number.isFinite(num('tx-start')) ? num('tx-start') : 0;
  }

  function setBuffer(tx, iq, source) {
    tx.buffer = iq;
    tx.source = source;
    tx.id = nextBufferId++;
  }

  /** Regenerates the buffer of a generated waveform from the fields. */
  function regenerate() {
    const tx = active();
    const kind = tx.waveform;
    if (!['noise', 'prn', 'chirp', 'tone'].includes(kind)) return;
    tx.length = Math.max(1, Math.min(MAX_BUFFER_SAMPLES, parseInt($('tx-length').value, 10) || 65536));
    tx.seed = parseInt($('tx-seed').value, 10) || 0;
    tx.degree = +$('tx-degree').value;
    setBuffer(tx, generate(kind, tx), kind);
  }

  function renderControls() {
    const kind = active().waveform;
    $('tx-length-field').hidden = !['noise', 'chirp'].includes(kind);
    $('tx-seed-field').hidden = kind !== 'noise';
    $('tx-degree-field').hidden = kind !== 'prn';
    $('tx-file-row').hidden = kind !== 'file';
    $('tx-python-row').hidden = kind !== 'python';
    $('tx-params').hidden = !['noise', 'chirp', 'prn'].includes(kind);
  }

  function lines(tx = active()) {
    if (!tx.buffer) return null;
    const c = cacheOf(tx);
    if (c.lines.id !== tx.id) c.lines = { id: tx.id, lines: linePowers(tx.buffer) };
    return c.lines.lines;
  }

  /** Received spectral shape of a transmitter for the current array (null without a buffer). */
  function shape(tx = active()) {
    const a = state.array;
    const c = cacheOf(tx);
    const key = `${tx.id}|${tx.frequency}|${tx.sampleRate}|${tx.bandwidth}|${a.sample_frequency}|${a.sample_window_size}|${a.downmix_frequency}|${a.bandpass}`;
    if (c.shape.key !== key) {
      const l = lines(tx);
      c.shape = { key, shape: l ? receivedShape(tx, l, a) : null };
    }
    return c.shape.shape;
  }

  function renderSummary() {
    const tx = active();
    const el = $('tx-summary');
    el.classList.remove('warn');
    if (!tx.buffer) {
      el.textContent = tx.waveform === 'python' ? 'Write and run buffer(ctx) to compute the buffer.' : 'Load a .cf32 buffer file.';
      el.classList.add('warn');
      return;
    }
    const L = tx.buffer.length / 2;
    const period = L / tx.sampleRate;
    const s = shape(tx);
    let [lo, hi] = occupiedBand(lines(tx), tx.sampleRate);
    if (tx.bandwidth) { lo = Math.max(lo, -tx.bandwidth / 2); hi = Math.min(hi, tx.bandwidth / 2); }
    lo += tx.frequency; hi += tx.frequency;
    const parts = [
      `${{ noise: 'White noise', prn: `PRN m-sequence (degree ${tx.degree})`, chirp: 'Chirp', tone: 'Tone', file: tx.source, python: 'Python buffer(ctx)' }[tx.waveform]}`,
      `${L.toLocaleString()} sample${L > 1 ? 's' : ''}, repeating every ${si(period, 3, 's')}`,
      L > 1 ? `lines every ${si(tx.sampleRate / L, 3, 'Hz')}, 99% of the power within ${MHz(lo)} – ${MHz(hi)}` : `a single line at ${MHz(tx.frequency)}`,
    ];
    const frac = s && s.total > 0 ? s.passed / s.total : 0;
    parts.push(`${(100 * frac).toFixed(frac > 0.995 || frac < 0.005 ? 0 : 1)}% of the power in the bandpass`);
    el.textContent = parts.join(' · ');
    if (frac < 0.005) {
      el.textContent += '. The array will not receive this transmitter: move the carrier into the band.';
      el.classList.add('warn');
    }
  }

  function changed() {
    renderSummary();
    ctx.onChange();
  }

  // Inputs
  for (const id of ['tx-freq', 'tx-rate', 'tx-bw', 'tx-start', 'tx-power']) {
    $(id).addEventListener('input', () => { read(); changed(); });
  }
  for (const id of ['tx-length', 'tx-seed', 'tx-degree']) {
    $(id).addEventListener('change', () => { regenerate(); changed(); });
  }
  $('tx-wave').addEventListener('change', (e) => {
    const tx = active();
    tx.waveform = e.target.value;
    renderControls();
    if (tx.waveform === 'file' || tx.waveform === 'python') {
      setBuffer(tx, tx.pythonBuffer && tx.waveform === 'python' ? tx.pythonBuffer : null, tx.waveform);
      if (tx.waveform === 'python' && !tx.buffer) ctx.openPython('transmitter');
    } else regenerate();
    changed();
  });
  $('tx-fit').addEventListener('click', () => {
    const tx = active();
    const [lo, hi] = M.physicalBand(state.array);
    tx.frequency = (lo + hi) / 2;
    tx.sampleRate = hi - lo;
    write();
    changed();
  });
  $('tx-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const tx = active();
      setBuffer(tx, parseCf32(await file.arrayBuffer()), file.name);
      toast(`Transmit buffer: ${(tx.buffer.length / 2).toLocaleString()} samples from ${file.name}`, 'ok');
      changed();
    } catch (err) {
      toast(`Buffer file: ${err.message}`, 'error');
    } finally {
      e.target.value = '';
    }
  });
  $('tx-python').addEventListener('click', () => ctx.openPython('transmitter'));
  $('tx-export-buffer').addEventListener('click', () => {
    const tx = active();
    if (tx.buffer) ctx.download(`${ctx.active().name.replace(/\W+/g, '_').toLowerCase()}.cf32`, serializeCf32(tx.buffer), 'application/octet-stream');
  });

  PRN_DEGREES.forEach((d) => $('tx-degree').add(new Option(`${d} · ${(2 ** d - 1).toLocaleString()} chips`, String(d))));

  return {
    write,
    shape,
    lines,
    renderSummary,
    /** Base64 cf32 of a transmitter's buffer (cached). */
    base64(tx = active()) {
      const c = cacheOf(tx);
      if (c.b64.id !== tx.id) c.b64 = { id: tx.id, text: toBase64(serializeCf32(tx.buffer)) };
      return c.b64.text;
    },
    /**
     * TransmitterDto of a calibrator for a request; `key` replaces the buffer by its identity (for
     * change detection).
     */
    dto(cal, power = cal.transmitter.power, { key = false } = {}) {
      const tx = cal.transmitter;
      if (!tx.buffer) {
        throw new Error(`${cal.name}: ${tx.waveform === 'python' ? 'run the Python buffer(ctx) for the transmitter first' : 'load a transmit buffer (.cf32) first'}`);
      }
      return {
        frequency: tx.frequency, sample_rate: tx.sampleRate, power, bandwidth: tx.bandwidth, start_time: tx.startTime,
        buffer: key ? `buffer#${tx.id}` : this.base64(tx),
      };
    },
    /** Adopts a loaded fringe calibrator's transmitter for a calibrator (not redrawing the controls). */
    adopt(tx, t, buffer, name) {
      Object.assign(tx, t);
      tx.waveform = 'file';
      setBuffer(tx, buffer, name);
    },
    /** Sets a calibrator's transmit power. */
    setPower(cal, p) {
      cal.transmitter.power = p;
      if (cal === ctx.active()) $('tx-power').value = p;
      changed();
    },

    /** The transmitter kind of the Python dialog (see pydialog.js); it edits the selected calibrator. */
    pythonKind: {
      get title() { return `Python transmit buffer · ${ctx.active().name}`; },
      fn: 'buffer',
      what: 'samples',
      get applyLabel() { return `Use as ${ctx.active().name}'s buffer`; },
      storageKey: 'fringe.transmitterCode',
      examples: TRANSMITTER_EXAMPLES,
      context() {
        read();
        const tx = active();
        const [fmin, fmax] = M.physicalBand(state.array);
        return {
          sample_rate: tx.sampleRate, frequency: tx.frequency, bandwidth: tx.bandwidth, power: tx.power,
          start_time: tx.startTime, fmin, fmax,
          sample_frequency: state.array.sample_frequency, downmix_frequency: state.array.downmix_frequency,
          window: state.array.sample_window_size, window_duration: state.array.sample_window_size / state.array.sample_frequency,
        };
      },
      decode: (res) => ({ buffer: new Float32Array(fromBase64(res.buffer)) }),
      count: (result) => result.buffer.length / 2,
      mountPreview(el) {
        el.innerHTML = '<div class="viz short"></div><div class="py-stats"></div>';
        const plot = new LinePlot(el.firstChild, { xLabel: 'frequency (MHz)', yLabel: 'power per line (dB)', legend: false, empty: 'Run the code to preview' });
        ctx.views.push(plot);
        const stats = el.lastChild;
        return {
          show(result) {
            if (!result) { plot.set([]); stats.innerHTML = ''; return; }
            const tx = active();
            const iq = result.buffer, L = iq.length / 2;
            const p = linePowers(iq);
            // Spectrum around the carrier, at most 4000 points (peak of each group of lines).
            const step = Math.ceil(L / 4000);
            const xs = [], ys = [];
            for (let j = 0; j < L; j += step) {
              let best = 0;
              for (let k = j; k < Math.min(L, j + step); k++) best = Math.max(best, p[(k + Math.ceil(L / 2)) % L]);
              const k0 = j + Math.floor(step / 2) - Math.floor(L / 2);
              xs.push((tx.frequency + (k0 * tx.sampleRate) / L) / 1e6);
              ys.push(10 * Math.log10(best || 1e-30));
            }
            const top = Math.max(...ys);
            plot.set([{ x: xs, y: ys.map((v) => Math.max(v, top - 80)), color: 's3' }]);
            const rms = Math.sqrt(meanPower(iq));
            let peak = 0;
            for (let i = 0; i < L; i++) peak = Math.max(peak, iq[2 * i] ** 2 + iq[2 * i + 1] ** 2);
            const rows = [
              ['Samples', L.toLocaleString(), L > MAX_BUFFER_SAMPLES ? 'warn' : ''],
              ['Period', si(L / tx.sampleRate, 4, 's'), ''],
              ['Line spacing', si(tx.sampleRate / L, 4, 'Hz'), ''],
              ['RMS', `${fmt(rms, 4)} (scaled to the EIRP)`, ''],
              ['Peak / RMS', `${fmt(10 * Math.log10(peak) - 20 * Math.log10(rms), 3)} dB`, ''],
            ];
            stats.innerHTML = `<dl>${rows.map(([k, v, cls]) => `<dt>${k}</dt><dd class="${cls || ''}">${v}</dd>`).join('')}</dl>`;
          },
        };
      },
      apply(result) {
        const tx = active();
        tx.waveform = 'python';
        tx.pythonBuffer = result.buffer;
        setBuffer(tx, result.buffer, 'Python buffer(ctx)');
        write();
        toast(`${ctx.active().name} transmit buffer from Python: ${(result.buffer.length / 2).toLocaleString()} samples`, 'ok');
        changed();
      },
    },
  };
}
