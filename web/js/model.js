// Client-side replica of fringe's signal model and file formats.
// Everything here mirrors src/library/{model,utils}.rs and cpu/mod.rs in fringe so the
// environment views agree with what the simulator actually computes.

export const C = 299792458.0;
/** One jansky (W m⁻² Hz⁻¹): sources are flux densities in Jy, and fringe's output samples are in √Jy. */
export const JANSKY = 1e-26;
/** Boltzmann's constant in Jy m² per kelvin: system noise k_B·T_sys is given in Jy m². */
export const K_B_JY = 1.380649e-23 / JANSKY;

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

/**
 * A sky source. alpha, alpha2 and alpha3 are fringe's spectral_index, spectral_index_2 and
 * spectral_index_3 (see sourceIntensity).
 */
export function makeSource(ra, dec, f0, I0, alpha, alpha2 = 0, alpha3 = 0) {
  const [x, y, z] = fromRaDec(ra, dec);
  return { ra, dec, f0, I0, alpha, alpha2, alpha3, x, y, z };
}

/**
 * Log-polynomial flux density (Jy), as Source::intensity: I0 · exp(α₁x + α₂x² + α₃x³) with
 * x = ln(f / f0), the power law I0 (f / f0)^α₁ when α₂ = α₃ = 0.
 */
export function sourceIntensity(s, f) {
  const x = Math.log(f / s.f0);
  return s.I0 * Math.exp(x * (s.alpha + x * ((s.alpha2 || 0) + x * (s.alpha3 || 0))));
}

/** Whether a source's spectrum is curved (a non-zero second- or third-order index). */
export const isCurved = (s) => !!(s.alpha2 || s.alpha3);

/** Local spectral index d ln S / d ln f at frequency f: α₁ + 2α₂x + 3α₃x², x = ln(f / f0). */
export function localIndex(s, f) {
  const x = Math.log(f / s.f0);
  return s.alpha + x * (2 * (s.alpha2 || 0) + 3 * x * (s.alpha3 || 0));
}

/** Antenna gain pattern fringe applies to sky sources: z² of the direction. */
export const sourceGain = (s) => s.z * s.z;

/** Effective area used for system noise (k_B·T_sys / A_eff is received as a flux density): λ²/4 capped at 4 m². */
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

/**
 * Power flux density (W/m²) the calibrator delivers to an antenna: gain · P / (4π d²), gain = ẑ²,
 * with P the transmitter's EIRP. Times a transmitter's spectral shape (transmitter.js, Jy per W/m²)
 * this gives the per-bin power in Jy.
 */
export function calibratorPower(cal, p) {
  const dx = cal.position.x - p.x, dy = cal.position.y - p.y, dz = cal.position.z - p.z;
  const d2 = dx * dx + dy * dy + dz * dz;
  if (d2 === 0) return 0;
  const gain = (dz * dz) / d2;
  return (gain * cal.power) / (4 * Math.PI * d2);
}

/** calibratorPower (W/m²) averaged over the antennas (0 without a calibrator). */
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
 * Analytic expected per-bin power vs physical frequency: the received flux density in Jy (sources
 * G·S(f), noise k_B·T_sys / A_eff, calibrator flux density spread over its spectrum).
 * Returns typed arrays for the sky, system noise, calibrators (summed in `cal`, one array per
 * calibrator in `cals`) and total contributions. Each calibrator's `shape` is its spectral shape
 * (see transmitter.js); without one it contributes nothing.
 */
export function modelSpectrum(array, sources, calibrators, freqs) {
  const n = freqs.length;
  const sky = new Float64Array(n), noise = new Float64Array(n), cal = new Float64Array(n), total = new Float64Array(n);
  const [lo, hi] = physicalBand(array);
  const cs = calibrators.map((c) => ({ shape: c.shape, power: c.shape ? meanCalibratorPower(c, array.antenna_positions) : 0 }));
  const cals = cs.map(() => new Float64Array(n));
  // Group sources by spectrum is not generally possible; just loop - typed for speed.
  const m = sources.length;
  const gI = new Float64Array(m), f0 = new Float64Array(m), a1 = new Float64Array(m), a2 = new Float64Array(m), a3 = new Float64Array(m);
  for (let i = 0; i < m; i++) {
    const s = sources[i];
    gI[i] = sourceGain(s) * s.I0; f0[i] = s.f0; a1[i] = s.alpha; a2[i] = s.alpha2 || 0; a3[i] = s.alpha3 || 0;
  }
  for (let k = 0; k < n; k++) {
    const f = freqs[k];
    if (f < lo || f > hi || f <= 0) {
      sky[k] = noise[k] = cal[k] = total[k] = NaN;
      for (const c of cals) c[k] = NaN;
      continue;
    }
    let s = 0;
    for (let i = 0; i < m; i++) {
      const x = Math.log(f / f0[i]);
      s += gI[i] * Math.exp(x * (a1[i] + x * (a2[i] + x * a3[i])));
    }
    sky[k] = s;
    noise[k] = array.system_noise_intensity / effectiveAperture(f);
    cal[k] = 0;
    cs.forEach((c, j) => { cals[j][k] = c.power ? c.power * c.shape.at(f) : 0; cal[k] += cals[j][k]; });
    total[k] = s + noise[k] + cal[k];
  }
  return { sky, noise, cal, cals, total };
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

/** In-place FFT of whole arrays (power-of-two length); the inverse is unscaled. */
export const fft = (re, im, inverse = false) => fft1d(re, im, re.length, 1, 0, inverse);

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
    const I = s.z * s.z * sourceIntensity(s, freq);
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
/** Columns fringe reads as 0 when they are absent. */
const OPTIONAL_SOURCE_COLUMNS = ['spectral_index_2', 'spectral_index_3'];

export function parseSourcesCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return [];
  const header = lines[0].split(',').map((h) => h.trim());
  const idx = SOURCE_COLUMNS.map((c) => header.indexOf(c));
  if (idx.some((i) => i < 0)) throw new Error(`sources CSV needs columns: ${SOURCE_COLUMNS.join(', ')} (and optionally ${OPTIONAL_SOURCE_COLUMNS.join(', ')})`);
  const opt = OPTIONAL_SOURCE_COLUMNS.map((c) => header.indexOf(c));
  return lines.slice(1).map((line, n) => {
    const cells = line.split(',');
    const v = idx.map((i) => parseFloat(cells[i]));
    // An empty optional cell reads as 0, like a missing column.
    const w = opt.map((i) => (i < 0 || !cells[i] || !cells[i].trim() ? 0 : parseFloat(cells[i])));
    if (v.some((x) => !Number.isFinite(x)) || w.some((x) => !Number.isFinite(x))) throw new Error(`sources CSV row ${n + 2} is not numeric`);
    return makeSource(v[0], v[1], v[2], v[3], v[4], w[0], w[1]);
  });
}

export function serializeSources(sources) {
  const rows = sources.map((s) => [s.ra, s.dec, s.f0, s.I0, s.alpha, s.alpha2 || 0, s.alpha3 || 0].join(','));
  return [[...SOURCE_COLUMNS, ...OPTIONAL_SOURCE_COLUMNS].join(','), ...rows].join('\n') + '\n';
}

/** A source as the server's request DTO (fringe's sources CSV row). */
export const sourceDto = (s) => ({
  right_ascension: s.ra, declination: s.dec, reference_frequency: s.f0, reference_intensity: s.I0,
  spectral_index: s.alpha, spectral_index_2: s.alpha2 || 0, spectral_index_3: s.alpha3 || 0,
});

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

/** Random point sources uniformly over the upper hemisphere with power-law flux densities (Jy at f0). */
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
 * observing 15–45 MHz with 4096-sample windows. The system noise k_B·T_sys is 1.38e7 Jy m² (T_sys = 10⁴ K).
 */
export const defaultArray = () => ({
  sample_frequency: 120e6,
  downmix_frequency: 0,
  bandpass: [15e6, 45e6],
  sample_window_size: 4096,
  system_noise_intensity: 13806490,
  antenna_positions: gridArray(32, 32, 4),
});

// ---------------------------------------------------------------------------------------
// Sky frames over time: mirrors the server's src/lunar.rs and rotation_basis in src/pipeline.rs.
// A basis holds the local east, north and up unit vectors in the sky's base frame; a source
// with base-frame direction v sits at (east·v, north·v, up·v) in the array frame.

const RAD = Math.PI / 180;
const TT_MINUS_UTC_S = 69.184;
const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** Local frame at the centre of the lunar far side (180°, 0°) at a UTC time (Unix seconds), in ICRS axes. */
export function farsideBasis(unix) {
  const d = (unix + TT_MINUS_UTC_S) / 86400 + 2440587.5 - 2451545.0;
  const t = d / 36525;
  const e = [0, 125.045 - 0.0529921 * d, 250.089 - 0.1059842 * d, 260.008 + 13.0120009 * d, 176.625 + 13.3407154 * d,
    357.529 + 0.9856003 * d, 311.589 + 26.4057084 * d, 134.963 + 13.0649930 * d, 276.617 + 0.3287146 * d,
    34.226 + 1.7484877 * d, 15.134 - 0.1589763 * d, 119.743 + 0.0036096 * d, 239.961 + 0.1643573 * d,
    25.053 + 12.9590088 * d].map((v) => v * RAD);
  const s = e.map(Math.sin), c = e.map(Math.cos);
  const a0 = (269.9949 + 0.0031 * t - 3.8787 * s[1] - 0.1204 * s[2] + 0.0700 * s[3] - 0.0172 * s[4]
    + 0.0072 * s[6] - 0.0052 * s[10] + 0.0043 * s[13]) * RAD;
  const d0 = (66.5392 + 0.0130 * t + 1.5419 * c[1] + 0.0239 * c[2] - 0.0278 * c[3] + 0.0068 * c[4]
    - 0.0029 * c[6] + 0.0009 * c[7] + 0.0008 * c[10] - 0.0009 * c[13]) * RAD;
  const w = (38.3213 + 13.17635815 * d - 1.4e-12 * d * d + 3.5610 * s[1] + 0.1208 * s[2]
    - 0.0642 * s[3] + 0.0158 * s[4] + 0.0252 * s[5] - 0.0066 * s[6] - 0.0047 * s[7]
    - 0.0046 * s[8] + 0.0028 * s[9] + 0.0052 * s[10] + 0.0040 * s[11] + 0.0019 * s[12]
    - 0.0044 * s[13]) * RAD;
  const pole = [Math.cos(d0) * Math.cos(a0), Math.cos(d0) * Math.sin(a0), Math.sin(d0)];
  const node = [-Math.sin(a0), Math.cos(a0), 0];
  const q = cross3(pole, node);
  const angle = w + Math.PI;
  const up = [0, 1, 2].map((i) => node[i] * Math.cos(angle) + q[i] * Math.sin(angle));
  return { east: cross3(pole, up), north: pole, up };
}

/** Local frame after the sky has turned by `angle` (radians, right-handed) about the unit vector `k`. */
export function rotationBasis(k, angle) {
  const s = Math.sin(angle), c = Math.cos(angle);
  const X = [[0, -k[2], k[1]], [k[2], 0, -k[0]], [-k[1], k[0], 0]];
  const row = (i) => [0, 1, 2].map((j) => c * (i === j ? 1 : 0) + s * X[i][j] + (1 - c) * k[i] * k[j]);
  return { east: row(0), north: row(1), up: row(2) };
}

/** Base-frame direction of an array-frame vector (the inverse of applying the basis). */
export const fromLocal = (b, [e, n, u]) => [0, 1, 2].map((i) => e * b.east[i] + n * b.north[i] + u * b.up[i]);
