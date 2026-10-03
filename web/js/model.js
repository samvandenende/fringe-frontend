// Client-side replica of fringe's signal model and file formats.
// Everything here mirrors src/library/{model,utils}.rs and cpu/mod.rs in fringe so the
// environment views agree with what the simulator actually computes.

export const C = 299792458.0;

/** Unit direction vector from right ascension / declination (radians), as Vec3::from_ra_dec. */
export function fromRaDec(ra, dec) {
  const c = Math.cos(dec);
  return [c * Math.cos(ra), c * Math.sin(ra), Math.sin(dec)];
}

/** Vec3::to_ra_dec: ra in [0, 2π), dec in [-π/2, π/2]. */
export function toRaDec(x, y, z) {
  const n = Math.hypot(x, y, z) || 1;
  const dec = Math.asin(Math.max(-1, Math.min(1, z / n)));
  let ra = Math.atan2(y / n, x / n);
  if (ra < 0) ra += 2 * Math.PI;
  return [ra, dec];
}

export function makeSource(ra, dec, f0, I0, alpha) {
  const [x, y, z] = fromRaDec(ra, dec);
  return { ra, dec, f0, I0, alpha, x, y, z };
}

/** Power-law intensity, as Source::intensity. */
export const sourceIntensity = (s, f) => s.I0 * Math.pow(f / s.f0, s.alpha);

/** Antenna gain pattern fringe applies to sky sources: z² of the direction. */
export const sourceGain = (s) => s.z * s.z;

/** Effective aperture used for system noise: λ²/4 capped at 4 m². */
export function effectiveAperture(f) {
  const lambda = C / f;
  return Math.min((lambda * lambda) / 4, 4);
}

export function centroid(positions) {
  let x = 0, y = 0, z = 0;
  for (const p of positions) { x += p.x; y += p.y; z += p.z; }
  const n = positions.length || 1;
  return { x: x / n, y: y / n, z: z / n };
}

/** Per-bin power the calibrator adds at an antenna: gain · I / (4π d²), gain = ẑ². */
export function calibratorPower(cal, p) {
  const dx = cal.position.x - p.x, dy = cal.position.y - p.y, dz = cal.position.z - p.z;
  const d2 = dx * dx + dy * dy + dz * dz;
  if (d2 === 0) return 0;
  const gain = (dz * dz) / d2;
  return (gain * cal.intensity) / (4 * Math.PI * d2);
}

export function meanCalibratorPower(cal, positions) {
  if (!cal || !cal.enabled || !positions.length) return 0;
  let s = 0;
  for (const p of positions) s += calibratorPower(cal, p);
  return s / positions.length;
}

/** Physical sky frequencies (Hz) spanned by the bandpass (baseband + downmix). */
export function physicalBand(array) {
  return [array.bandpass[0] + array.downmix_frequency, array.bandpass[1] + array.downmix_frequency];
}

/**
 * Analytic expected per-bin power vs physical frequency, in fringe's intensity units.
 * Returns typed arrays for the sky, system noise, calibrator and total contributions.
 */
export function modelSpectrum(array, sources, calibrator, freqs) {
  const n = freqs.length;
  const sky = new Float64Array(n), noise = new Float64Array(n), cal = new Float64Array(n), total = new Float64Array(n);
  const [lo, hi] = physicalBand(array);
  const calPower = meanCalibratorPower(calibrator, array.antenna_positions);
  // Group sources by (f0, alpha) is not generally possible; just loop - typed for speed.
  const m = sources.length;
  const gI = new Float64Array(m), f0 = new Float64Array(m), al = new Float64Array(m);
  for (let i = 0; i < m; i++) {
    const s = sources[i];
    gI[i] = sourceGain(s) * s.I0; f0[i] = s.f0; al[i] = s.alpha;
  }
  for (let k = 0; k < n; k++) {
    const f = freqs[k];
    if (f < lo || f > hi || f <= 0) { sky[k] = noise[k] = cal[k] = total[k] = NaN; continue; }
    let s = 0;
    for (let i = 0; i < m; i++) s += gI[i] * Math.pow(f / f0[i], al[i]);
    sky[k] = s;
    noise[k] = array.system_noise_intensity / effectiveAperture(f);
    cal[k] = calPower;
    total[k] = s + noise[k] + calPower;
  }
  return { sky, noise, cal, total };
}

export function arrayStats(positions) {
  const n = positions.length;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const p of positions) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
    minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z);
  }
  // Longest baseline: exact for small arrays, via convex-ish extremes otherwise.
  let maxBaseline = 0;
  let minSpacing = Infinity;
  if (n <= 2500) {
    for (let i = 0; i < n; i++) {
      const a = positions[i];
      for (let j = i + 1; j < n; j++) {
        const b = positions[j];
        const d = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
        if (d > maxBaseline) maxBaseline = d;
        if (d < minSpacing) minSpacing = d;
      }
    }
  } else {
    maxBaseline = Math.hypot(maxX - minX, maxY - minY, maxZ - minZ);
    minSpacing = NaN;
  }
  return {
    n, minX, maxX, minY, maxY, minZ, maxZ,
    extent: Math.max(maxX - minX, maxY - minY, 1e-9),
    maxBaseline, minSpacing: n > 1 ? minSpacing : NaN,
    planar: maxZ - minZ < 1e-9,
    baselines: (n * (n - 1)) / 2,
  };
}

// ---------------------------------------------------------------------------------------
// Beams and images (pure functions so they can run in a worker)

/**
 * Array power pattern |Σ_a exp(i k (Δl x_a + Δm y_a))|² / A² on a size × size grid
 * spanning [-span, span] in direction-cosine offsets. 1 at the origin.
 */
export function arrayPattern(xs, ys, freq, size, span) {
  const A = xs.length;
  const k = (2 * Math.PI * freq) / C;
  const coord = (i) => -span + ((i + 0.5) * 2 * span) / size;
  const lRe = new Float32Array(size * A), lIm = new Float32Array(size * A);
  for (let i = 0; i < size; i++) {
    const u = coord(i);
    for (let a = 0; a < A; a++) {
      const ph = k * u * xs[a];
      lRe[i * A + a] = Math.cos(ph); lIm[i * A + a] = Math.sin(ph);
    }
  }
  const out = new Float32Array(size * size);
  const fRe = new Float32Array(A), fIm = new Float32Array(A);
  const inv = 1 / (A * A);
  for (let j = 0; j < size; j++) {
    const v = coord(j);
    for (let a = 0; a < A; a++) {
      const ph = k * v * ys[a];
      fRe[a] = Math.cos(ph); fIm[a] = Math.sin(ph);
    }
    for (let i = 0; i < size; i++) {
      let sr = 0, si = 0;
      const o = i * A;
      for (let a = 0; a < A; a++) {
        const wr = lRe[o + a], wi = lIm[o + a];
        sr += fRe[a] * wr - fIm[a] * wi;
        si += fRe[a] * wi + fIm[a] * wr;
      }
      out[j * size + i] = (sr * sr + si * si) * inv;
    }
  }
  return out;
}

/** In-place iterative radix-2 complex FFT. `n` must be a power of two. */
function fft1d(re, im, n, stride, offset, inverse) {
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const a = offset + i * stride, b = offset + j * stride;
      let t = re[a]; re[a] = re[b]; re[b] = t;
      t = im[a]; im[a] = im[b]; im[b] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inverse ? 2 : -2) * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let j = 0; j < len / 2; j++) {
        const a = offset + (i + j) * stride, b = offset + (i + j + len / 2) * stride;
        const xr = re[b] * cr - im[b] * ci, xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr; im[b] = im[a] - xi;
        re[a] += xr; im[a] += xi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
}

function fft2d(re, im, n, inverse) {
  for (let r = 0; r < n; r++) fft1d(re, im, n, 1, r * n, inverse);
  for (let c = 0; c < n; c++) fft1d(re, im, n, n, c, inverse);
}

/**
 * Expected dirty image for a planar array: the apparent sky (sources with z > 0 at their
 * (l, m) = (x, y)) convolved with the array pattern, plus the system noise floor N/A_eff/A.
 * Sources are incoherent (independent random phases), so their beam powers add.
 * Matches the normalisation of the server's dirty images.
 */
export function expectedImage({ xs, ys, sources, freq, size, noisePower }) {
  const A = xs.length;
  const n = size * 2;
  // Sky grid with bilinear splatting.
  const sky = new Float64Array(size * size);
  const px = size / 2;
  for (const s of sources) {
    if (s.z <= 0) continue;
    const I = s.z * s.z * s.I0 * Math.pow(freq / s.f0, s.alpha);
    const fx = (s.x + 1) * px - 0.5, fy = (s.y + 1) * px - 0.5;
    const x0 = Math.floor(fx), y0 = Math.floor(fy);
    const tx = fx - x0, ty = fy - y0;
    for (const [dx, dy, w] of [[0, 0, (1 - tx) * (1 - ty)], [1, 0, tx * (1 - ty)], [0, 1, (1 - tx) * ty], [1, 1, tx * ty]]) {
      const x = x0 + dx, y = y0 + dy;
      if (x >= 0 && x < size && y >= 0 && y < size) sky[y * size + x] += I * w;
    }
  }
  // Kernel at pixel offsets -(size-1)..(size-1), laid out circularly on an n × n grid.
  const kernel = integerOffsetPattern(xs, ys, freq, size);
  const kr = new Float64Array(n * n), ki = new Float64Array(n * n);
  for (let dj = -(size - 1); dj <= size - 1; dj++) {
    for (let di = -(size - 1); di <= size - 1; di++) {
      const v = kernel[(dj + size - 1) * (2 * size - 1) + (di + size - 1)];
      kr[((dj + n) % n) * n + ((di + n) % n)] = v;
    }
  }
  const sr = new Float64Array(n * n), si = new Float64Array(n * n);
  for (let j = 0; j < size; j++) for (let i = 0; i < size; i++) sr[j * n + i] = sky[j * size + i];
  fft2d(sr, si, n, false);
  fft2d(kr, ki, n, false);
  for (let i = 0; i < n * n; i++) {
    const r = sr[i] * kr[i] - si[i] * ki[i];
    si[i] = sr[i] * ki[i] + si[i] * kr[i];
    sr[i] = r;
  }
  fft2d(sr, si, n, true);
  const out = new Float32Array(size * size);
  const inv = 1 / (n * n);
  const floor = noisePower / A;
  for (let j = 0; j < size; j++) {
    const m = -1 + ((j + 0.5) * 2) / size;
    for (let i = 0; i < size; i++) {
      const l = -1 + ((i + 0.5) * 2) / size;
      out[j * size + i] = l * l + m * m > 1 ? NaN : sr[j * n + i] * inv + floor;
    }
  }
  return out;
}

/** Array pattern on integer pixel offsets (step 2/size), (2·size-1)² samples. */
function integerOffsetPattern(xs, ys, freq, size) {
  const m = 2 * size - 1;
  const span = (2 * size - 1) / size; // so sample centres land exactly on k·(2/size)
  return arrayPattern(xs, ys, freq, m, span);
}

// ---------------------------------------------------------------------------------------
// File formats (identical to fringe's save_*/load_* functions)

export function parseArrayJson(text) {
  const o = JSON.parse(text);
  const need = ['sample_frequency', 'downmix_frequency', 'bandpass', 'sample_window_size', 'system_noise_intensity', 'antenna_positions'];
  for (const k of need) if (!(k in o)) throw new Error(`array file is missing "${k}"`);
  if (!Array.isArray(o.bandpass) || o.bandpass.length !== 2) throw new Error('bandpass must be [f_min, f_max]');
  return {
    sample_frequency: +o.sample_frequency,
    downmix_frequency: +o.downmix_frequency,
    bandpass: [+o.bandpass[0], +o.bandpass[1]],
    sample_window_size: +o.sample_window_size,
    system_noise_intensity: +o.system_noise_intensity,
    antenna_positions: o.antenna_positions.map((p) => ({ x: +p.x, y: +p.y, z: +p.z })),
  };
}

export function serializeArray(a) {
  return JSON.stringify({
    sample_frequency: a.sample_frequency,
    downmix_frequency: a.downmix_frequency,
    bandpass: a.bandpass,
    sample_window_size: a.sample_window_size,
    system_noise_intensity: a.system_noise_intensity,
    antenna_positions: a.antenna_positions,
  }, null, 2);
}

const SOURCE_COLUMNS = ['right_ascension', 'declination', 'reference_frequency', 'reference_intensity', 'spectral_index'];

export function parseSourcesCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return [];
  const header = lines[0].split(',').map((h) => h.trim());
  const idx = SOURCE_COLUMNS.map((c) => header.indexOf(c));
  if (idx.some((i) => i < 0)) throw new Error(`sources CSV needs columns: ${SOURCE_COLUMNS.join(', ')}`);
  return lines.slice(1).map((line, n) => {
    const cells = line.split(',');
    const v = idx.map((i) => parseFloat(cells[i]));
    if (v.some((x) => !Number.isFinite(x))) throw new Error(`sources CSV row ${n + 2} is not numeric`);
    return makeSource(v[0], v[1], v[2], v[3], v[4]);
  });
}

export function serializeSources(sources) {
  const rows = sources.map((s) => [s.ra, s.dec, s.f0, s.I0, s.alpha].join(','));
  return [SOURCE_COLUMNS.join(','), ...rows].join('\n') + '\n';
}

export function parseCalibratorJson(text) {
  const o = JSON.parse(text);
  if (!o.position || !('intensity' in o)) throw new Error('calibrator file needs "position" and "intensity"');
  return { enabled: true, position: { x: +o.position.x, y: +o.position.y, z: +o.position.z }, intensity: +o.intensity };
}

export function serializeCalibrator(c) {
  return JSON.stringify({ position: c.position, intensity: c.intensity }, null, 2);
}

// ---------------------------------------------------------------------------------------
// Generators

/** Small deterministic PRNG so generated environments are reproducible. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function gridArray(nx, ny, spacing) {
  const out = [];
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) out.push({ x: i * spacing, y: j * spacing, z: 0 });
  return out;
}

export function randomArray(n, radius, seed) {
  const rnd = mulberry32(seed);
  const out = [];
  for (let i = 0; i < n; i++) {
    const r = radius * Math.sqrt(rnd()), t = 2 * Math.PI * rnd();
    out.push({ x: r * Math.cos(t), y: r * Math.sin(t), z: 0 });
  }
  return out;
}

export function ringArray(n, radius) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = (2 * Math.PI * i) / n;
    out.push({ x: radius * Math.cos(t), y: radius * Math.sin(t), z: 0 });
  }
  return out;
}

/** Random point sources uniformly over the upper hemisphere with power-law intensities. */
export function randomSky(n, seed, { f0 = 30e6, minI = 100, maxI = 10000, alpha = -0.7 } = {}) {
  const rnd = mulberry32(seed);
  const out = [];
  for (let i = 0; i < n; i++) {
    const ra = 2 * Math.PI * rnd();
    const dec = Math.asin(rnd()); // uniform on the hemisphere
    const I = minI * Math.pow(maxI / minI, Math.pow(rnd(), 3));
    out.push(makeSource(ra, dec, f0, I, alpha + (rnd() - 0.5) * 0.4));
  }
  return out;
}

/**
 * Default environment: a 32 × 32 grid with 4 m spacing (0.4 λ at 30 MHz) sampled at 120 MHz,
 * observing 15–45 MHz with 4096-sample windows. The system noise intensity is k_B × 1e30.
 */
export const defaultArray = () => ({
  sample_frequency: 120e6,
  downmix_frequency: 0,
  bandpass: [15e6, 45e6],
  sample_window_size: 4096,
  system_noise_intensity: 13806490,
  antenna_positions: gridArray(32, 32, 4),
});
