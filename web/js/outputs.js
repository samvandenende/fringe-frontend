// Data products saved to HDF5, and the Outputs tab that lists them.
import * as M from './model.js';
import { LinePlot, fmt, si } from './plot.js';

const $ = (id) => document.getElementById(id);
const MHz = (f) => `${+(f / 1e6).toFixed(3)} MHz`;

function median(values) {
  const a = values.filter(Number.isFinite).sort((x, y) => x - y);
  return a.length ? a[a.length >> 1] : NaN;
}

/**
 * ctx: { state, api, toast, views, integrations(), hasCalibrator(), calibratorCount(), onChange() }
 * integrations: the number of integrations the next run will simulate.
 */
export function initOutputs(ctx) {
  const { state, api, toast } = ctx;
  const tdoaPlot = new LinePlot($('out-tdoa-plot'), { xLabel: 'integration', yLabel: 'TDOA residual rms (ns)', yLog: true });
  ctx.views.push(tdoaPlot);
  let latest = null;

  const antennas = () => state.array.antenna_positions;

  function products() {
    return {
      raw: $('prod-raw').checked,
      tdoa: $('prod-tdoa').checked && ctx.hasCalibrator(),
      reference_antenna: parseInt($('prod-ref').value, 10) || 0,
      images: $('prod-images').checked ? {
        frequency: parseFloat($('prod-img-f').value) * 1e6,
        bandwidth: parseFloat($('prod-img-bw').value) * 1e6,
        size: parseInt($('prod-img-size').value, 10),
      } : null,
    };
  }

  const any = () => { const p = products(); return p.raw || p.tdoa || !!p.images; };

  function nearestCentroidAntenna() {
    const c = M.centroid(antennas());
    let best = 0, bd = Infinity;
    antennas().forEach((p, i) => { const d = Math.hypot(p.x - c.x, p.y - c.y, p.z - c.z); if (d < bd) { bd = d; best = i; } });
    return best;
  }

  /** Size estimates, availability and the section badge. */
  function render() {
    const n = ctx.integrations(), a = antennas().length, w = state.array.sample_window_size;
    const px = parseInt($('prod-img-size').value, 10);
    const cals = Math.max(1, ctx.calibratorCount());
    const sizes = { raw: n * a * w * 8, tdoa: cals * n * a * 20, images: n * px * px * 4 };
    $('prod-raw-size').textContent = `· ${si(sizes.raw, 3, 'B')}`;
    $('prod-tdoa-size').textContent = `· ${si(sizes.tdoa, 3, 'B')}`;
    $('prod-images-size').textContent = `· ${si(sizes.images, 3, 'B')}`;

    const calibrator = ctx.hasCalibrator();
    $('prod-tdoa').disabled = !calibrator;
    $('prod-tdoa-label').title = calibrator
      ? 'One set per calibrator, each correlated over its own transmit band; calibrators sharing a band bias each other'
      : 'Needs a calibrator (kinematic or series, under Calibrators)';
    $('prod-tdoa-params').hidden = !($('prod-tdoa').checked && calibrator);
    $('prod-images-params').hidden = !$('prod-images').checked;

    const p = products();
    const total = (p.raw ? sizes.raw : 0) + (p.tdoa ? sizes.tdoa : 0) + (p.images ? sizes.images : 0);
    $('out-name-field').hidden = !any();
    const note = $('output-note');
    if (!any()) {
      note.textContent = 'Nothing is saved; results appear under Signals and Imaging only.';
      note.classList.remove('warn');
      $('output-badge').textContent = '';
    } else {
      // Same sanitising as the server; it appends -1, -2, … if the file exists.
      const stem = ($('out-name').value || 'fringe_run').trim().replace(/\.h5$/, '').replace(/[^A-Za-z0-9._-]/g, '_');
      note.textContent = `${n} integration${n === 1 ? '' : 's'} → output/${stem}.h5, ≈ ${si(total + 1e5, 3, 'B')}` +
        (total > 20e9 ? ' — large output.' : '');
      note.classList.toggle('warn', total > 20e9);
      $('output-badge').textContent = `saves ${si(total + 1e5, 2, 'B')}`;
    }
  }

  async function onJobFinished({ quiet = false } = {}) {
    let r;
    try { r = await api('/pipeline/result'); } catch { return null; }
    if (!r.file) return r;
    latest = r;
    renderResults(r);
    loadFiles();
    if (!quiet) {
      $('outputs-dot').hidden = document.querySelector('.tabs .on').dataset.tab === 'outputs';
      toast(`Saved ${r.integrations} integrations to ${r.file} — see Outputs.`, 'ok');
    }
    return r;
  }

  function renderResults(r) {
    $('out-results-card').hidden = false;
    $('outputs-empty').hidden = true;
    const url = `/api/pipeline/files/${encodeURIComponent(r.file)}`;
    const products = [r.products.raw && 'raw samples', r.tdoa && 'TDOA', r.images && 'images'].filter(Boolean).join(', ');
    $('out-results-caption').innerHTML = `<a href="${url}" download>${r.file}</a> · ${products}`;
    const tiles = [
      ['File size', si(r.size_bytes, 3, 'B'), `<a href="${url}" download>download</a>`],
      ['Integrations', `${r.integrations}${r.integrations < r.requested_integrations ? ` / ${r.requested_integrations}` : ''}`, `${si(median(r.window_s), 3, 's')} per window`],
      ['Total time', si(r.total_s, 3, 's'), r.sky_frame === 'fixed' ? 'fixed sky' : 'rotated sky'],
    ];
    // Integrations with a calibrator switched off come back as null.
    const tdoa = (r.tdoa || []).map((t) => ({ ...t, rms_s: t.rms_s.map((v) => v ?? NaN), median_snr: t.median_snr.map((v) => v ?? NaN) }));
    for (const t of tdoa) {
      const who = tdoa.length > 1 ? `${t.calibrator} ` : '';
      tiles.push([`${who}TDOA residual (median)`, `${fmt(median(t.rms_s) * 1e9, 3)} ns`, `rms per integration; all: ${fmt((t.overall_rms_s ?? NaN) * 1e9, 3)} ns`]);
      tiles.push([`${who}Correlation SNR (median)`, fmt(median(t.median_snr), 3), `reference antenna ${t.reference_antenna}`]);
    }
    if (r.images) tiles.push(['Images', `${r.images.size}² px`, `${MHz(r.images.frequency)} ± ${MHz(r.images.bandwidth / 2)} (${r.images.bins} bins)`]);
    $('out-result-tiles').innerHTML = tiles.map(([k, v, sub]) =>
      `<div class="tile"><div class="k">${k}</div><div class="v">${v}</div><div class="s">${sub}</div></div>`).join('');

    $('out-tdoa-plot').hidden = !tdoa.length;
    if (tdoa.length) {
      tdoaPlot.set(tdoa.map((t, k) => ({
        label: tdoa.length > 1 ? t.calibrator : '', x: t.rms_s.map((_, i) => i), y: t.rms_s.map((v) => v * 1e9),
        color: state.calibrators.find((c) => c.name === t.calibrator)?.color || ['s3', 's4', 's5', 's6'][k % 4],
      })));
    }
  }

  async function loadFiles() {
    try {
      const { directory, files } = await api('/pipeline/outputs');
      $('out-files-caption').textContent = directory;
      $('out-files').innerHTML = files.length
        ? `<table>${files.map((f) => `<tr><td><a href="/api/pipeline/files/${encodeURIComponent(f.name)}" download>${f.name}</a></td>` +
          `<td>${si(f.size_bytes, 3, 'B')}</td><td>${new Date(f.modified * 1000).toLocaleString()}</td></tr>`).join('')}</table>`
        : '<p class="note">No files yet.</p>';
      $('outputs-empty').hidden = !!latest || files.length > 0;
    } catch { /* server unavailable; reported elsewhere */ }
  }

  for (const id of ['prod-raw', 'prod-tdoa', 'prod-images', 'prod-img-size']) {
    $(id).addEventListener('change', () => { render(); ctx.onChange(); });
  }
  $('out-name').addEventListener('input', render);
  $('prod-ref-centre').addEventListener('click', () => { $('prod-ref').value = nearestCentroidAntenna(); });
  $('prod-ref').value = nearestCentroidAntenna();

  return {
    products,
    any,
    name: () => $('out-name').value || 'fringe_run',
    render,
    onJobFinished,
    loadFiles,
  };
}
