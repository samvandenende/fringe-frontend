# fringe frontend

[github.com/samvandenende/fringe-frontend](https://github.com/samvandenende/fringe-frontend)

A browser-based environment for the [fringe](https://github.com/samvandenende/fringe) radio
interferometer simulator: configure the array, sky model and calibrator, run the real fringe
simulation on the CPU or GPU runtime, and inspect everything it produces — time-domain antenna
samples, spectra, waterfalls and beamformed sky images — next to the analytic expectation.

![The Environment tab: 3D scene of the array under the sky sphere, derived parameters, array layout, GSM2016 sky on the lunar far side and the array beam](ui.png)

## Running

Requires Rust (same toolchain as fringe). fringe itself is a git dependency on
[github.com/samvandenende/fringe](https://github.com/samvandenende/fringe), pinned to a commit in
`Cargo.lock`; `cargo update -p fringe` moves to the latest commit.

```bash
cargo run --release
# fringe frontend running at http://127.0.0.1:8080
```

Options:

| Flag | Default | Description |
|------|---------|-------------|
| `--bind`, `-b` | `127.0.0.1:8080` | Address to serve on |
| `--web-dir` | `./web` | Static frontend directory |
| `--python` | `python3` | Interpreter for GSM2016 sky models (`pygdsm`, `healpy`, `astropy`) and Python array layouts (`numpy`) |
| `--allow-remote-code` | off | Allow Python layouts when bound to a non-loopback address (anyone who can reach the server can then run code as you) |

## Default environment

The frontend starts with a self-contained environment; *Default* in the Array and Sky model
sections restores it.

- **Array** (built in, `defaultArray()` in `web/js/model.js`): a 32 × 32 grid with 4 m spacing
  (0.4 λ at 30 MHz, 124 m across), 120 MHz sampling, no downmix, a 15–45 MHz bandpass,
  4096-sample windows and system noise intensity 13806490 (k_B × 10³⁰).
- **Sky model** (bundled, `web/data/default_sky.csv`): GSM2016 at NSIDE 32 in the lunar far-side
  frame at 2026-01-01T00:00 UTC, above the horizon only (6144 sources), with spectral indices
  fitted over five maps from 15 to 45 MHz. At that epoch the site is in lunar night and the
  galactic anticentre is near the zenith. `web/data/default_sky.json` holds the generator's
  summary. It is generated rather than built in because GSM2016 needs Python and PyGDSM, which are
  optional; regenerate it with

  ```bash
  python3 scripts/gsm_sky.py --nside 32 --maps 5 --fmin 15e6 --fmax 45e6 \
      --frame lunar-farside --epoch 2026-01-01T00:00:00 \
      --output web/data/default_sky.csv 2> >(grep '^SUMMARY ' | cut -c9- > web/data/default_sky.json)
  ```

Arrays and sky models in fringe's file formats (including fringe's own `examples/`) can still be
loaded with *Load JSON* / *Load CSV*.

## What you get

**Environment** — the simulation set-up, before anything runs:

- *Scene*: orbitable 3D view of the antenna array, the sky sources on the unit sphere and the
  calibrator, in fringe's local frame (z = zenith).
- *Array layout*, *sky model* (orthographic l/m projection, coloured by intrinsic or apparent
  `z² · I(f)` intensity) and the *array beam* (zenith-steered power pattern, showing grating lobes).
- *Spectral model*: expected per-bin power from sky sources, system noise (`N / A_eff`) and the
  calibrator (`z² I / 4πd²`), exactly as fringe synthesises them.
- *Derived parameters*: sampling/channel resolution, baselines, angular resolution, aliasing
  limit, sky-to-noise ratio, data volume.

**Signals** — after a run:

- Run statistics (time per window, throughput, real-time factor).
- In-band power per antenna (click an antenna to inspect it).
- Complex time-domain samples of the last window, sample distribution vs Gaussian.
- Mean power spectrum per antenna and array-averaged, overlaid with the analytic model.
- Waterfall of array-averaged power per integration window.

**Imaging** — dirty images formed by beamforming the simulated E-fields at any imaging channel,
averaged over all integrations, compared with the *expected image* (sky model convolved with the
array pattern plus the noise floor) and the PSF.

The sidebar edits everything fringe takes as input. Arrays, sky models and calibrators load from
and export to fringe's own file formats (`array.json`, `sources.csv`, `calibrator.json`), so the
frontend doubles as an editor for CLI and Python inputs. Grid / random / ring layouts and random
skies can be generated in place.

### Python array layouts

*Array → Python…* opens an editor in which you write a `layout(ctx)` function that returns the
antenna positions in metres: an `(N, 2)` or `(N, 3)` array-like (z = 0 when omitted), or a list of
`{"x", "y", "z"}` dicts. `ctx` carries the current array settings — `sample_frequency`,
`downmix_frequency`, `bandpass`, `fmin`/`fmax` (sky band), `wavelength_min`/`wavelength_max`,
`sample_window_size`, `c` and the current `positions` — so layouts can be written in wavelengths
or derived from the current array. `numpy` (`np`) and `math` are preloaded; `print()` output and
tracebacks appear in the console, and the result is previewed (with spacing / grating-lobe
checks) before *Apply to array*. Examples cover λ/2 grids, hexagonal disks, random layouts with a
minimum spacing, spiral arms, rings, perturbing the current array and loading a file. The code is
kept in the browser's local storage.

The function runs in your own Python (`--python`), so it can use any installed package and read
local files. Because that means executing code sent over HTTP, the endpoint only works when the
server listens on a loopback address (or with `--allow-remote-code`), only accepts requests whose
`Host` is localhost (against DNS rebinding), and only accepts JSON bodies (which other websites
cannot send cross-origin without a CORS preflight the server never grants). Each run is limited
to 60 s.

### GSM2016 sky models

*Sky model → Generate from GSM2016 (PyGDSM)* builds a sky from the
[PyGDSM](https://github.com/telegraphic/pygdsm) Global Sky Model 2016, one source per HEALPix
pixel (`pip install pygdsm`; the server detects it at start-up). Options:

- **NSIDE** of the output sky, **fit maps** (number of GSM maps, evenly spaced over the fit range,
  used to fit each pixel's spectral index) and the **fit range** (defaults to the array's bandpass,
  floored at GSM2016's 10 MHz limit).
- **Frame** written as RA/Dec (fringe's zenith is Dec = +90°). The default, *lunar far side*, is
  the local east/north/up frame of an observer on the lunar equator at the centre of the far side
  (selenographic longitude 180°, latitude 0°) at the chosen **epoch** (UTC): x = east,
  y = north (lunar spin axis), z = zenith, so Dec is elevation. The site orientation comes from the
  IAU/WGCCRE 2009 lunar rotation model (including physical libration), so the zenith stays within
  ~8° of the anti-Earth direction and sweeps the ecliptic once per sidereal month. The default
  epoch, 2026-01-01T00:00 UTC, is lunar night at the site with the galactic anticentre near the
  zenith. Generation reports the zenith direction and the Sun and Earth elevations (neither is in
  the sky model). ICRS and galactic frames are also available.
- **Base maps**: GSM2016 low (NSIDE 64) or high (NSIDE 1024) resolution; *auto* uses low for NSIDE ≤ 8.
- Keep only Dec > 0 (fringe still sums sources below its horizon, with gain z²).

Maps are generated with `data_unit="MJysr"` and converted to Jansky per pixel
(`× 1e6 × 4π / N_pix`). A power law is fitted per pixel in log space, with the reference frequency
at the geometric mean of the map frequencies. GSM2016 has non-positive pixels at low frequencies;
those samples are left out of the fit, and pixels with fewer than two positive samples get α = 0.
The generator is `scripts/gsm_sky.py`, which also works standalone:

```bash
python3 scripts/gsm_sky.py --nside 32 --maps 5 --fmin 15e6 --fmax 45e6 \
    --frame lunar-farside --epoch 2026-01-01T00:00:00 --output sky.csv
```

## Architecture

```
src/
  main.rs       axum server: static files + JSON API, runs one simulation at a time
  job.rs        request validation (mirrors fringe's asserts) and the start/finish loop
  analysis.rs   per-window FFTs, spectra, waterfall, E-field store, dirty imaging
  gsm.rs        GSM2016 sky generation via the embedded scripts/gsm_sky.py
  pycode.rs     Python array layouts via the embedded scripts/layout_runner.py
scripts/
  gsm_sky.py    PyGDSM GSM2016 → fringe sources CSV (also usable standalone)
  layout_runner.py  runs a user's layout(ctx) and validates the positions
web/
  index.html, style.css
  js/main.js    state, sidebar bindings, run orchestration, tab rendering
  js/model.js   client-side replica of fringe's signal model and file formats
  js/plot.js    canvas line plots and heatmaps
  js/views.js   3D scene, array map, sky map
  js/worker.js  array patterns and expected images off the main thread
  js/editor.js  small Python code editor (highlighting, indentation, undo)
  js/layouts.js example layout functions
  data/default_sky.csv, default_sky.json   bundled default GSM2016 sky and its generator summary
```

The server links fringe directly and drives `Simulation::start`/`finish` in a pipelined loop, so
the analysis of one window overlaps simulation of the next. Raw samples never leave the server
(the default array produces 32 MB per window); it keeps per-antenna mean spectra, the last
window's samples and, for each integration, the E-field of every antenna at the imaging channels.

Spectra are normalised so that a stationary signal's expected power per bin equals the
intensity fringe synthesises; images are normalised by `antennas²` so a point source peaks at its
apparent intensity. Both line up with the analytic model, which makes the frontend a quick check
of the simulator itself.

### API

| Method & path | Description |
|---|---|
| `GET /api/info` | Server version, thread count, availability of GSM2016 and Python layouts |
| `POST /api/array/python` | Run a layout function (`code`, `context`) → `{ positions, stdout }` or `{ error, stdout }` |
| `POST /api/sky/gsm` | GSM2016 sky model (`nside`, `maps`, `fmin`, `fmax`, `frame`, `epoch`, `resolution`, `above_horizon`) → `{ csv, summary }` |
| `POST /api/run` | Start a run (`runtime`, `frequency_resolution`, `rng_seed`, `integrations`, `array`, `sources`, `calibrator`, `analysis`) |
| `GET /api/run/status` | State, progress, elapsed time, error message |
| `POST /api/run/cancel` | Stop after the current window (partial results are kept) |
| `GET /api/run/summary` | Timings, mean spectrum, per-antenna power, waterfall, imaging channels |
| `GET /api/run/antenna/{i}` | Last-window samples and mean spectrum of one antenna |
| `GET /api/run/image?channel=&size=` | Dirty image at an imaging channel |
