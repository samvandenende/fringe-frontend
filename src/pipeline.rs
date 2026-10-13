//! Calibrator-oriented simulation pipelines.
//!
//! A pipeline runs one integration window per timeline row (UTC timestamp, and the array-frame
//! state of each calibrator: position, velocity, acceleration and transmit power). Each window
//! starts at its time after the first row, so the calibrators' transmit buffers and Doppler shifts
//! stay continuous across integrations. The sky is fixed in the array frame, given in
//! ICRS and rotated into the lunar far-side frame at each timestamp, or given in the array frame
//! at an epoch and rotated about a fixed axis at a constant rate. Selected data
//! products are written to one HDF5 file: raw antenna samples, calibrator time differences of
//! arrival (TDOA) and per-integration dirty images. Static runs that save products use the same
//! path with identical rows.

use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;

use fringe::{Calibrator, Simulation, Source, Transmitter, Vec3};
use hdf5::types::VarLenUnicode;
use ndarray::{Array1, Array2, Array3, s};
use num_complex::Complex32;
use rayon::prelude::*;
use rustfft::{Fft, FftPlanner};
use serde::{Deserialize, Serialize};

use crate::analysis::{Accumulator, RunResult, beamform};
use crate::job::{
    AnalysisDto, ArrayDto, CalibratorDto, JobState, MAX_CALIBRATORS, RunRequest, SourceDto, TransmitterDto, ValidatedRequest,
    calibrator_label, check_state,
};
use crate::lunar::{self, Basis};

const C: f64 = 299_792_458.0;
/// Zero-padding factor of the cross-correlation used for TDOA estimation.
const TDOA_OVERSAMPLE: usize = 4;

#[derive(Deserialize, Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "kebab-case")]
pub enum SkyFrame {
    /// Sources are ICRS RA/Dec, rotated into the lunar far-side frame at each timestamp.
    LunarFarside,
    /// Sources are already in the array frame and do not move.
    Fixed,
    /// Sources are in the array frame at the rotation epoch; the sky then turns at a constant
    /// rate about a fixed axis (see [`SkyRotation`]).
    Rotating,
}

/// Constant-rate sky rotation: the observer spins right-handed about `axis` (array frame) at
/// `rate` degrees per hour, so the sky turns the other way, starting from `epoch`.
#[derive(Deserialize, Clone)]
pub struct SkyRotation {
    pub epoch: String,
    pub axis: Vec3,
    pub rate: f64,
}

/// Local frame after the sky has turned by `angle` (radians, right-handed) about the unit `axis`:
/// the rows of the Rodrigues rotation matrix.
fn rotation_basis(k: [f64; 3], angle: f64) -> Basis {
    let (s, c) = angle.sin_cos();
    let row = |i: usize| -> [f64; 3] {
        let cross = [[0.0, -k[2], k[1]], [k[2], 0.0, -k[0]], [-k[1], k[0], 0.0]];
        std::array::from_fn(|j| c * f64::from(u8::from(i == j)) + s * cross[i][j] + (1.0 - c) * k[i] * k[j])
    };
    Basis { east: row(0), north: row(1), up: row(2) }
}

#[derive(Deserialize, Serialize, Clone)]
pub struct ImageProduct {
    /// Centre frequency (physical, Hz) and bandwidth over which bin images are averaged.
    pub frequency: f64,
    pub bandwidth: f64,
    pub size: usize,
}

#[derive(Deserialize, Serialize, Clone)]
pub struct Products {
    pub raw: bool,
    pub tdoa: bool,
    pub reference_antenna: usize,
    pub images: Option<ImageProduct>,
}

/// Calibrator state at one integration (array frame), valid at the start of its window.
#[derive(Deserialize, Clone, Copy)]
pub struct CalibratorState {
    pub position: Vec3,
    #[serde(default)]
    pub velocity: Vec3,
    #[serde(default)]
    pub acceleration: Vec3,
    /// Transmit power (EIRP, W) at this integration; 0 switches the calibrator off.
    pub power: f64,
}

/// One calibrator over the timeline: a transmitter (whose `power` is replaced by each state's)
/// and one state per integration.
#[derive(Deserialize)]
pub struct PipelineCalibrator {
    /// Label for messages, saved files and summaries; "calibrator k" (counting from 1) when absent.
    #[serde(default)]
    pub name: Option<String>,
    pub transmitter: TransmitterDto,
    pub states: Vec<CalibratorState>,
}

#[derive(Deserialize)]
pub struct PipelineRequest {
    pub runtime: String,
    pub frequency_resolution: usize,
    pub rng_seed: Option<u64>,
    pub array: ArrayDto,
    /// One UTC timestamp (ISO 8601) per integration, and each calibrator's state at each.
    pub times: Vec<String>,
    #[serde(default)]
    pub calibrators: Vec<PipelineCalibrator>,
    pub sky_frame: SkyFrame,
    /// Required for (and only used by) the rotating sky frame.
    #[serde(default)]
    pub sky_rotation: Option<SkyRotation>,
    pub sources: Vec<SourceDto>,
    pub products: Products,
    pub analysis: AnalysisDto,
    pub output_name: String,
}

pub struct Plan {
    base: ValidatedRequest,
    times: Vec<String>,
    /// Seconds after the first timestamp at which each window starts.
    offsets: Vec<f64>,
    /// Each calibrator at each integration (`calibrators[k][n]`); its epoch is the window start.
    calibrators: Vec<Vec<Calibrator>>,
    /// Each calibrator's label.
    calibrator_names: Vec<String>,
    sky_frame: SkyFrame,
    /// Human-readable sky frame, stored in the HDF5 file.
    sky_description: String,
    bases: Vec<Basis>,
    products: Products,
    /// Absent when no data product is selected.
    output: Option<PathBuf>,
}

impl Plan {
    pub fn integrations(&self) -> usize {
        self.times.len()
    }
}

impl PipelineRequest {
    pub fn validate(self, output_dir: &Path) -> Result<Plan, String> {
        let n = self.times.len();
        if n == 0 {
            return Err("the timeline has no integrations".into());
        }
        if self.calibrators.len() > MAX_CALIBRATORS {
            return Err(format!("at most {MAX_CALIBRATORS} calibrators are supported"));
        }
        let calibrator_names: Vec<String> =
            self.calibrators.iter().enumerate().map(|(k, c)| calibrator_label(c.name.as_deref(), k)).collect();
        if let Some(k) = self.calibrators.iter().position(|c| c.states.len() != n) {
            return Err(format!("{}: there must be one state per timestamp", calibrator_names[k]));
        }
        let unix = self
            .times
            .iter()
            .enumerate()
            .map(|(i, t)| lunar::parse_utc(t).map_err(|e| format!("row {}: {e}", i + 1)))
            .collect::<Result<Vec<_>, _>>()?;
        // Offsets from whole seconds and fractions separately: Unix times near 1.8e9 s only
        // resolve ~0.2 µs in f64, coarser than back-to-back windows need.
        let parts = self.times.iter().map(|t| lunar::parse_utc_parts(t)).collect::<Result<Vec<_>, _>>()?;
        let offsets: Vec<f64> = parts.iter().map(|(w, f)| (w - parts[0].0) as f64 + (f - parts[0].1)).collect();
        let calibrators = self
            .calibrators
            .iter()
            .enumerate()
            .map(|(k, c)| {
                let transmitter: Transmitter = c.transmitter.build().map_err(|e| format!("{}: {e}", calibrator_names[k]))?;
                c.states
                    .iter()
                    .zip(&offsets)
                    .enumerate()
                    .map(|(i, (s, t))| {
                        let at = |e: String| format!("{}, row {}: {e}", calibrator_names[k], i + 1);
                        check_state(s.position, s.velocity, s.acceleration, &self.array.antenna_positions).map_err(at)?;
                        if !(s.power.is_finite() && s.power >= 0.0) {
                            return Err(at("power must be non-negative".into()));
                        }
                        // Clones share the buffer, so fringe conditions it only once.
                        let mut transmitter = transmitter.clone();
                        transmitter.set_power(s.power);
                        Ok(Calibrator::new(s.position, transmitter, Some(s.velocity), Some(s.acceleration), *t))
                    })
                    .collect::<Result<Vec<_>, String>>()
            })
            .collect::<Result<Vec<_>, String>>()?;

        let products = self.products.clone();
        if products.tdoa && calibrators.is_empty() {
            return Err("calibrator TDOAs need a calibrator".into());
        }
        if products.tdoa && products.reference_antenna >= self.array.antenna_positions.len() {
            return Err("the TDOA reference antenna index is out of range".into());
        }
        if let Some(img) = &products.images {
            if !(16..=512).contains(&img.size) {
                return Err("image size must be between 16 and 512 pixels".into());
            }
            let lo = self.array.bandpass[0] + self.array.downmix_frequency;
            let hi = self.array.bandpass[1] + self.array.downmix_frequency;
            if !(img.frequency >= lo && img.frequency <= hi) {
                return Err("the image frequency must lie inside the bandpass".into());
            }
            if !(img.bandwidth.is_finite() && img.bandwidth >= 0.0) {
                return Err("the image bandwidth must be non-negative".into());
            }
        }

        let (bases, sky_description) = match self.sky_frame {
            SkyFrame::LunarFarside => (
                unix.iter().map(|t| lunar::farside_basis(*t)).collect(),
                "lunar-farside: ICRS sources; x = east, y = north (lunar spin axis), z = up at selenographic (180°, 0°)".to_string(),
            ),
            SkyFrame::Fixed => (Vec::new(), "fixed: sources given in the array frame".to_string()),
            SkyFrame::Rotating => {
                let r = self.sky_rotation.as_ref().ok_or("the rotating sky frame needs sky_rotation")?;
                let epoch = lunar::parse_utc(&r.epoch).map_err(|e| format!("rotation epoch: {e}"))?;
                let norm = r.axis.norm();
                if !(norm.is_finite() && norm > 0.0) {
                    return Err("the rotation axis must be a non-zero vector".into());
                }
                if !r.rate.is_finite() {
                    return Err("the rotation rate must be finite".into());
                }
                let k = [r.axis.x / norm, r.axis.y / norm, r.axis.z / norm];
                let bases = unix.iter().map(|t| rotation_basis(k, -(r.rate * (t - epoch) / 3600.0).to_radians())).collect();
                let description = format!(
                    "rotating: sources in the array frame at {}; the sky turns at {} deg/h about axis ({:.6}, {:.6}, {:.6}), opposite to the observer's spin",
                    r.epoch.trim(), r.rate, k[0], k[1], k[2]
                );
                (bases, description)
            }
        };
        let saves = products.raw || products.tdoa || products.images.is_some();
        let output = if saves { Some(unique_output_path(output_dir, &self.output_name)?) } else { None };

        // Reuse the single-run validation for the array, sources, runtime and analysis settings.
        let base = RunRequest {
            runtime: self.runtime,
            frequency_resolution: self.frequency_resolution,
            rng_seed: self.rng_seed,
            integrations: n,
            array: self.array,
            sources: self.sources,
            calibrators: self
                .calibrators
                .into_iter()
                .map(|c| CalibratorDto {
                    name: c.name,
                    position: c.states[0].position,
                    velocity: c.states[0].velocity,
                    acceleration: c.states[0].acceleration,
                    transmitter: TransmitterDto { power: c.states[0].power, ..c.transmitter },
                })
                .collect(),
            analysis: self.analysis,
        }
        .validate()?;

        Ok(Plan {
            base,
            times: self.times,
            offsets,
            calibrators,
            calibrator_names,
            sky_frame: self.sky_frame,
            sky_description,
            bases,
            products,
            output,
        })
    }
}

/// `<output_dir>/<name>.h5`, sanitised and made unique with a numeric suffix.
fn unique_output_path(dir: &Path, name: &str) -> Result<PathBuf, String> {
    let stem: String = name
        .trim()
        .trim_end_matches(".h5")
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || "-_.".contains(c) { c } else { '_' })
        .collect();
    let stem = stem.trim_matches('.');
    if stem.is_empty() {
        return Err("the output name is empty".into());
    }
    std::fs::create_dir_all(dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    let mut path = dir.join(format!("{stem}.h5"));
    let mut i = 1;
    while path.exists() {
        path = dir.join(format!("{stem}-{i}.h5"));
        i += 1;
    }
    Ok(path)
}

// -------------------------------------------------------------------------------------------------
// TDOA estimation

/// Estimates each antenna's delay relative to a reference antenna by band-limited
/// cross-correlation, zero-padded for resolution, with a parabolic fit around the peak.
///
/// A positive delay means the antenna receives the common signal later than the reference:
/// `x_a(t) ≈ x_ref(t − τ)`.
pub struct TdoaEstimator {
    window_size: usize,
    sample_frequency: f64,
    band: (usize, usize),
    max_lag: usize,
    forward: Arc<dyn Fft<f32>>,
    inverse: Arc<dyn Fft<f32>>,
    reference: usize,
}

pub struct TdoaWindow {
    pub delay_s: Vec<f64>,
    pub snr: Vec<f32>,
}

impl TdoaEstimator {
    pub fn new(window_size: usize, sample_frequency: f64, band: (usize, usize), max_delay_s: f64, reference: usize) -> Self {
        let mut planner = FftPlanner::new();
        let padded = window_size * TDOA_OVERSAMPLE;
        TdoaEstimator {
            window_size,
            sample_frequency,
            band,
            max_lag: ((max_delay_s * sample_frequency).ceil() as usize + 4) * TDOA_OVERSAMPLE,
            forward: planner.plan_fft_forward(window_size),
            inverse: planner.plan_fft_inverse(padded),
            reference,
        }
    }

    /// Spectra of each antenna's window, which `estimate_spectra` correlates (and estimators of
    /// the same window size can share).
    pub fn spectra(&self, window: &[Vec<Complex32>]) -> Vec<Vec<Complex32>> {
        window
            .par_iter()
            .map(|samples| {
                let mut buffer = samples.clone();
                self.forward.process(&mut buffer);
                buffer
            })
            .collect()
    }

    #[cfg(test)]
    pub fn estimate(&self, window: &[Vec<Complex32>]) -> TdoaWindow {
        self.estimate_spectra(&self.spectra(window))
    }

    pub fn estimate_spectra(&self, spectra: &[Vec<Complex32>]) -> TdoaWindow {
        let w = self.window_size;
        let reference = &spectra[self.reference];
        let padded = w * TDOA_OVERSAMPLE;
        let max_lag = self.max_lag.min(padded / 2 - 2);
        let rate = self.sample_frequency * TDOA_OVERSAMPLE as f64;

        let (delay_s, snr): (Vec<f64>, Vec<f32>) = spectra
            .par_iter()
            .map(|x| {
                let mut corr = vec![Complex32::new(0.0, 0.0); padded];
                for k in self.band.0..=self.band.1 {
                    corr[k] = x[k] * reference[k].conj();
                }
                self.inverse.process(&mut corr);
                let mag = |lag: isize| corr[lag.rem_euclid(padded as isize) as usize].norm();
                let (mut best, mut peak) = (0isize, -1.0f32);
                for lag in -(max_lag as isize)..=(max_lag as isize) {
                    let v = mag(lag);
                    if v > peak {
                        peak = v;
                        best = lag;
                    }
                }
                let (y0, y1, y2) = (mag(best - 1), peak, mag(best + 1));
                let denom = y0 - 2.0 * y1 + y2;
                let offset = if denom.abs() > f32::EPSILON { 0.5 * (y0 - y2) / denom } else { 0.0 };

                // Noise level: median magnitude away from the search window.
                let mut off: Vec<f32> = (max_lag + 1..padded - max_lag).map(|i| corr[i].norm()).collect();
                let snr = if off.is_empty() {
                    f32::NAN
                } else {
                    let mid = off.len() / 2;
                    let median = *off.select_nth_unstable_by(mid, |a, b| a.total_cmp(b)).1;
                    if median > 0.0 { peak / median } else { f32::INFINITY }
                };
                ((best as f64 + offset as f64) / rate, snr)
            })
            .unzip();
        TdoaWindow { delay_s, snr }
    }
}

// -------------------------------------------------------------------------------------------------
// Output

fn attr<T: hdf5::H5Type>(loc: &hdf5::Location, name: &str, value: &T) -> hdf5::Result<()> {
    loc.new_attr::<T>().create(name)?.write_scalar(value)
}

fn attr_str(loc: &hdf5::Location, name: &str, value: &str) -> hdf5::Result<()> {
    let v = VarLenUnicode::from_str(value).map_err(|e| hdf5::Error::from(e.to_string()))?;
    attr(loc, name, &v)
}

fn vec3_rows(v: &[Vec3]) -> Array2<f64> {
    Array2::from_shape_fn((v.len(), 3), |(i, j)| [v[i].x, v[i].y, v[i].z][j])
}

struct Writer {
    file: hdf5::File,
    raw: Option<hdf5::Dataset>,
    /// Measured delay, expected delay and SNR datasets, per calibrator.
    tdoa: Vec<[hdf5::Dataset; 3]>,
    images: Option<hdf5::Dataset>,
}

impl Writer {
    fn create(plan: &Plan, path: &Path, image_bins: usize) -> hdf5::Result<Self> {
        let req = &plan.base;
        let a = &req.array_dto;
        let n = plan.integrations();
        let n_ant = a.antenna_positions.len();
        let file = hdf5::File::create(path)?;

        attr_str(&file, "producer", concat!("fringe-frontend ", env!("CARGO_PKG_VERSION")))?;
        attr_str(&file, "runtime", &req.runtime)?;
        attr(&file, "frequency_resolution", &(req.frequency_resolution as u64))?;
        attr(&file, "rng_seed", &req.rng_seed)?;
        attr(&file, "integrations_requested", &(n as u64))?;
        attr(&file, "integrations_completed", &0u64)?;
        attr_str(&file, "sky_frame", &plan.sky_description)?;

        let array = file.create_group("array")?;
        array.new_dataset_builder().with_data(&vec3_rows(&a.antenna_positions)).create("positions")?;
        attr(&array, "sample_frequency", &a.sample_frequency)?;
        attr(&array, "downmix_frequency", &a.downmix_frequency)?;
        attr(&array, "bandpass_fmin", &a.bandpass[0])?;
        attr(&array, "bandpass_fmax", &a.bandpass[1])?;
        attr(&array, "sample_window_size", &(a.sample_window_size as u64))?;
        attr(&array, "system_noise_intensity", &a.system_noise_intensity)?;
        attr_str(&array, "units", "positions in m; frequencies in Hz; system_noise_intensity is k_B T_sys in Jy m^2 \
            (1 Jy m^2 = 1e-26 W/Hz), received as a flux density of system_noise_intensity / A_eff with \
            A_eff = min(lambda^2 / 4, 4 m^2)")?;

        let time = file.create_group("time")?;
        let utc = plan
            .times
            .iter()
            .map(|t| VarLenUnicode::from_str(t.trim()).map_err(|e| hdf5::Error::from(e.to_string())))
            .collect::<hdf5::Result<Vec<_>>>()?;
        time.new_dataset_builder().with_data(&Array1::from(utc)).create("utc")?;
        time.new_dataset_builder().with_data(&Array1::from(plan.offsets.clone())).create("offset_s")?;

        let mut tdoa = Vec::new();
        if !plan.calibrators.is_empty() {
            let group = file.create_group("calibrators")?;
            attr(&group, "count", &(plan.calibrators.len() as u64))?;
            attr_str(&group, "description", "one subgroup per calibrator, named by its index from 0")?;
        }
        for (k, states) in plan.calibrators.iter().enumerate() {
            let cal = file.create_group(&format!("calibrators/{k}"))?;
            attr_str(&cal, "name", &plan.calibrator_names[k])?;
            attr_str(&cal, "description", "calibrator state at the start of each integration window (array frame); \
                it moves as position + velocity·t + acceleration·t²/2 during the window")?;
            let rows = |f: fn(&Calibrator) -> Vec3| vec3_rows(&states.iter().map(f).collect::<Vec<_>>());
            let ds = cal.new_dataset_builder().with_data(&rows(Calibrator::position)).create("position")?;
            attr_str(&ds, "units", "m")?;
            let ds = cal.new_dataset_builder().with_data(&rows(Calibrator::velocity)).create("velocity")?;
            attr_str(&ds, "units", "m/s")?;
            let ds = cal.new_dataset_builder().with_data(&rows(Calibrator::acceleration)).create("acceleration")?;
            attr_str(&ds, "units", "m/s^2")?;
            let ds = cal
                .new_dataset_builder()
                .with_data(&Array1::from_iter(states.iter().map(|c| c.transmitter().power())))
                .create("power")?;
            attr_str(&ds, "units", "W, equivalent isotropically radiated power (0 = switched off)")?;
            let tx = states[0].transmitter();
            let t = cal.create_group("transmitter")?;
            attr(&t, "frequency", &tx.frequency())?;
            attr(&t, "sample_rate", &tx.sample_rate())?;
            attr(&t, "bandwidth", &tx.bandwidth().unwrap_or(f64::NAN))?;
            attr(&t, "start_time", &tx.start_time())?;
            attr_str(&t, "description", "carrier frequency (Hz), buffer sample rate (Hz), reconstruction filter bandwidth \
                (Hz, NaN = none) and the time (s after the first integration) of the first buffer sample; the buffer \
                holds relative levels and is transmitted cyclically, scaled to radiate calibrator/power (W EIRP)")?;
            t.new_dataset_builder().with_data(&Array1::from(tx.buffer())).create("buffer")?;

            if plan.products.tdoa {
                let g = cal.create_group("tdoa")?;
                attr(&g, "reference_antenna", &(plan.products.reference_antenna as u64))?;
                attr_str(&g, "description", "delay of each antenna relative to the reference antenna (positive = later), \
                    estimated by cross-correlation over the calibrator's transmit band within the bandpass; \
                    expected = (|cal - r_a| - |cal - r_ref|) / c; measured and snr are NaN while the calibrator is off")?;
                let mk = |name: &str| g.new_dataset::<f64>().shape((n, n_ant)).create(name);
                let snr = g.new_dataset::<f32>().shape((n, n_ant)).create("snr")?;
                tdoa.push([mk("measured_s")?, mk("expected_s")?, snr]);
            }
        }

        let sky = file.create_group("sky")?;
        let table = Array2::from_shape_fn((req.sources.len(), 7), |(i, j)| {
            let s = &req.sources[i];
            let (ra, dec) = s.direction().to_ra_dec();
            [ra, dec, s.reference_frequency(), s.reference_intensity(), s.spectral_index(), s.spectral_index_2(), s.spectral_index_3()][j]
        });
        let ds = sky.new_dataset_builder().with_data(&table).create("sources")?;
        attr_str(
            &ds,
            "columns",
            "right_ascension, declination, reference_frequency, reference_intensity, spectral_index, spectral_index_2, spectral_index_3",
        )?;
        attr_str(&ds, "units", "rad, rad, Hz, Jy (flux density at reference_frequency), dimensionless, dimensionless, dimensionless")?;
        attr_str(&ds, "spectrum", "S(f) = reference_intensity * exp(a1 x + a2 x^2 + a3 x^3), x = ln(f / reference_frequency)")?;
        if !plan.bases.is_empty() {
            let bases = Array3::from_shape_fn((n, 3, 3), |(i, r, c)| {
                let b = &plan.bases[i];
                [b.east, b.north, b.up][r][c]
            });
            let ds = sky.new_dataset_builder().with_data(&bases).create("frame_basis")?;
            let axes = if plan.sky_frame == SkyFrame::Rotating { "the array frame at the rotation epoch" } else { "ICRS axes" };
            attr_str(&ds, "description", &format!("rows: east, north, up unit vectors in {axes}, per integration"))?;
        }

        let raw = if plan.products.raw {
            let g = file.create_group("raw")?;
            let ds = g
                .new_dataset::<Complex32>()
                .shape((n, n_ant, a.sample_window_size))
                .chunk((1, n_ant, a.sample_window_size))
                .create("samples")?;
            attr_str(&ds, "dimensions", "integration, antenna, sample")?;
            attr_str(&ds, "units", "sqrt(Jy): the mean power is the flux density received per antenna, averaged over the sample frequency")?;
            Some(ds)
        } else {
            None
        };

        let images = match &plan.products.images {
            Some(img) => {
                let g = file.create_group("images")?;
                let ds = g.new_dataset::<f32>().shape((n, img.size, img.size)).create("dirty")?;
                attr(&ds, "frequency", &img.frequency)?;
                attr(&ds, "bandwidth", &img.bandwidth)?;
                attr(&ds, "bins_averaged", &(image_bins as u64))?;
                attr_str(&ds, "dimensions", "integration, m (row 0 at m = -1), l (column 0 at l = -1); NaN below the horizon")?;
                attr_str(&ds, "units", "Jy, apparent flux density: beam power / antennas², averaged over bins")?;
                Some(ds)
            }
            None => None,
        };

        Ok(Writer { file, raw, tdoa, images })
    }

    fn write(&self, n: usize, window: &[Vec<Complex32>], tdoa: &[(TdoaWindow, Vec<f64>)], image: Option<&[f32]>) -> hdf5::Result<()> {
        if let Some(ds) = &self.raw {
            let w = window[0].len();
            let flat: Vec<Complex32> = window.iter().flatten().copied().collect();
            let arr = Array2::from_shape_vec((window.len(), w), flat).map_err(|e| hdf5::Error::from(e.to_string()))?;
            ds.write_slice(&arr, s![n, .., ..])?;
        }
        for ([measured, expected, snr], (est, exp)) in self.tdoa.iter().zip(tdoa) {
            measured.write_slice(&Array1::from(est.delay_s.clone()), s![n, ..])?;
            expected.write_slice(&Array1::from(exp.clone()), s![n, ..])?;
            snr.write_slice(&Array1::from(est.snr.clone()), s![n, ..])?;
        }
        if let (Some(ds), Some(img)) = (&self.images, image) {
            let size = (img.len() as f64).sqrt() as usize;
            let arr = Array2::from_shape_vec((size, size), img.to_vec()).map_err(|e| hdf5::Error::from(e.to_string()))?;
            ds.write_slice(&arr, s![n, .., ..])?;
        }
        Ok(())
    }

    fn finish(&self, completed: usize) -> hdf5::Result<()> {
        self.file.attr("integrations_completed")?.write_scalar(&(completed as u64))?;
        self.file.flush()
    }
}

// -------------------------------------------------------------------------------------------------
// Execution

#[derive(Serialize)]
pub struct TdoaSummary {
    /// The calibrator's label.
    pub calibrator: String,
    pub reference_antenna: usize,
    pub rms_s: Vec<f64>,
    pub median_snr: Vec<f32>,
    pub overall_rms_s: f64,
}

/// Baseband FFT bins (inclusive) a transmitter can occupy within the bandpass: its buffer spans
/// ±sample_rate/2 about the carrier (less with a narrower filter), widened by one bin for Doppler.
/// Falls back to the whole bandpass when the transmitter misses it.
fn transmit_band(tx: &Transmitter, a: &ArrayDto) -> (usize, usize) {
    let w = a.sample_window_size;
    let to_bin = |f: f64| f * w as f64 / a.sample_frequency;
    let lo = to_bin(a.bandpass[0]).ceil() as usize;
    let hi = (to_bin(a.bandpass[1]).floor() as usize).min(w / 2 - 1);
    let half = tx.bandwidth().map_or(tx.sample_rate(), |b| b.min(tx.sample_rate())) / 2.0;
    let centre = tx.frequency() - a.downmix_frequency;
    let tx_lo = (to_bin(centre - half).floor() - 1.0).max(0.0) as usize;
    let tx_hi = (to_bin(centre + half).ceil() + 1.0).max(0.0) as usize;
    let (b0, b1) = (lo.max(tx_lo), hi.min(tx_hi));
    if b0 <= b1 { (b0, b1) } else { (lo, hi) }
}

/// Propagation delay (s) of a signal received at `receiver` at `time`, emitted by the calibrator
/// at `time - delay` (fixed-point iteration, as fringe solves it).
fn light_time(calibrator: &Calibrator, receiver: Vec3, time: f64) -> f64 {
    let mut delay = (receiver - calibrator.position_at(time)).norm() / C;
    for _ in 0..4 {
        delay = (receiver - calibrator.position_at(time - delay)).norm() / C;
    }
    delay
}

#[derive(Serialize)]
pub struct ImageSummary {
    pub frequency: f64,
    pub bandwidth: f64,
    pub bins: usize,
    pub size: usize,
}

#[derive(Serialize)]
pub struct PipelineSummary {
    /// Output file name, if any product was saved.
    pub file: Option<String>,
    pub size_bytes: u64,
    pub integrations: usize,
    pub requested_integrations: usize,
    pub sky_frame: SkyFrame,
    pub products: Products,
    pub total_s: f64,
    pub window_s: Vec<f64>,
    /// One summary per calibrator.
    pub tdoa: Option<Vec<TdoaSummary>>,
    pub images: Option<ImageSummary>,
}

pub struct PipelineOutcome {
    pub summary: PipelineSummary,
    pub run: RunResult,
}

/// Sky sources at one integration. In the lunar frame, sources are rotated into the local
/// frame and those below the horizon get zero flux density, which keeps the source count constant
/// and stops fringe from summing emission from behind the Moon.
fn sky_at(base: &[Source], active: &[usize], basis: Option<&Basis>) -> Vec<Source> {
    match basis {
        None => base.to_vec(),
        Some(b) => active
            .iter()
            .map(|&i| {
                let s = &base[i];
                let d = s.direction();
                let [e, n, u] = b.to_local([d.x, d.y, d.z]);
                let intensity = if u > 0.0 { s.reference_intensity() } else { 0.0 };
                Source::new(
                    Vec3::new(e, n, u),
                    s.reference_frequency(),
                    intensity,
                    s.spectral_index(),
                    s.spectral_index_2(),
                    s.spectral_index_3(),
                )
            })
            .collect(),
    }
}

pub fn execute(plan: Plan, cancel: &AtomicBool, mut on_progress: impl FnMut(JobState, usize)) -> Result<PipelineOutcome, String> {
    let started = Instant::now();
    on_progress(JobState::Initializing, 0);
    let req = &plan.base;
    let a = req.array_dto.clone();
    let n_int = plan.integrations();
    let w = a.sample_window_size;
    let positions = a.antenna_positions.clone();

    // Sources that are above the horizon at some integration (all of them for a fixed sky).
    let active: Vec<usize> = if plan.bases.is_empty() {
        (0..req.sources.len()).collect()
    } else {
        (0..req.sources.len())
            .filter(|&i| {
                let d = req.sources[i].direction();
                plan.bases.iter().any(|b| b.to_local([d.x, d.y, d.z])[2] > 0.0)
            })
            .collect()
    };
    let basis = |n: usize| plan.bases.get(n);

    // Imaging: Hann-windowed bins within the requested bandwidth.
    let image_bins: Vec<(usize, f64)> = match &plan.products.images {
        Some(img) => {
            let to_bin = |f: f64| (f - a.downmix_frequency) * w as f64 / a.sample_frequency;
            let lo = (to_bin(img.frequency - img.bandwidth / 2.0).ceil() as isize).max(1) as usize;
            let hi = (to_bin(img.frequency + img.bandwidth / 2.0).floor() as usize).min(w / 2 - 1);
            let bins: Vec<usize> = if hi >= lo { (lo..=hi).collect() } else { vec![to_bin(img.frequency).round() as usize] };
            bins.into_iter().map(|b| (b, b as f64 * a.sample_frequency / w as f64 + a.downmix_frequency)).collect()
        }
        None => Vec::new(),
    };
    let window_coefficients: Vec<f32> = {
        // Same normalisation as the run analysis: amplitude scaled by 1/sqrt(Σw²).
        let c: Vec<f32> = (0..w).map(|i| (0.5 - 0.5 * (std::f64::consts::TAU * i as f64 / w as f64).cos()) as f32).collect();
        let energy: f32 = c.iter().map(|v| v * v).sum();
        c.into_iter().map(|v| v / energy.sqrt()).collect()
    };
    let image_fft = FftPlanner::new().plan_fft_forward(w);

    // One estimator per calibrator, correlating only the bins its transmitter can occupy so that
    // calibrators in other bands do not bias it (calibrators sharing a band still do).
    let tdoa: Vec<TdoaEstimator> = if plan.products.tdoa {
        let reference = positions[plan.products.reference_antenna];
        let max_delay = positions.iter().map(|p| (*p - reference).norm()).fold(0.0, f64::max) / C;
        plan.calibrators
            .iter()
            .map(|states| {
                let band = transmit_band(&states[0].transmitter(), &a);
                TdoaEstimator::new(w, a.sample_frequency, band, max_delay, plan.products.reference_antenna)
            })
            .collect()
    } else {
        Vec::new()
    };

    let writer = match &plan.output {
        Some(path) => Some(Writer::create(&plan, path, image_bins.len()).map_err(|e| format!("cannot create {}: {e}", path.display()))?),
        None => None,
    };
    let output_name = plan.output.as_ref().map(|p| p.display().to_string()).unwrap_or_default();

    let mut simulation = Simulation::new(req.runtime.clone(), req.array.clone(), req.frequency_resolution, Some(req.rng_seed));
    let mut accumulator = Accumulator::new(req);
    let mut window_s = Vec::with_capacity(n_int);
    let mut tdoa_rows: Vec<Vec<(Vec<f64>, Vec<f64>, Vec<f32>)>> = vec![Vec::new(); tdoa.len()];
    let mut last_window = None;

    // Calibrators that are off for a window keep their place with zero power: fringe only reuses
    // conditioned buffers from the previous set, so dropping one would re-condition it later.
    let calibrators_at = |n: usize| plan.calibrators.iter().map(|states| states[n].clone()).collect::<Vec<_>>();
    simulation.set_sources(sky_at(&req.sources, &active, basis(0)));
    if !plan.calibrators.is_empty() {
        simulation.set_calibrators(calibrators_at(0));
    }
    let mut window_started = Instant::now();
    simulation.start(Some(plan.offsets[0]));
    on_progress(JobState::Running, 0);

    let mut completed = 0;
    for n in 0..n_int {
        let window = simulation.finish();
        window_s.push(window_started.elapsed().as_secs_f64());
        window_started = Instant::now();
        let more = n + 1 < n_int && !cancel.load(Ordering::Relaxed);
        if more {
            simulation.set_sources(sky_at(&req.sources, &active, basis(n + 1)));
            if !plan.calibrators.is_empty() {
                simulation.set_calibrators(calibrators_at(n + 1));
            }
            simulation.start(Some(plan.offsets[n + 1]));
        }

        accumulator.add(&window);

        let spectra = tdoa.first().map(|est| est.spectra(&window));
        let tdoa_result: Vec<(TdoaWindow, Vec<f64>)> = tdoa
            .iter()
            .zip(&plan.calibrators)
            .map(|(est, states)| {
                let cal = &states[n];
                let measured = if cal.transmitter().power() > 0.0 {
                    est.estimate_spectra(spectra.as_deref().unwrap_or_default())
                } else {
                    TdoaWindow { delay_s: vec![f64::NAN; positions.len()], snr: vec![f32::NAN; positions.len()] }
                };
                // Light-time delays at the middle of the window, so a moving calibrator is exact.
                let mid = plan.offsets[n] + 0.5 * w as f64 / a.sample_frequency;
                let reference = light_time(cal, positions[plan.products.reference_antenna], mid);
                let expected: Vec<f64> = positions.iter().map(|p| light_time(cal, *p, mid) - reference).collect();
                (measured, expected)
            })
            .collect();

        let image = (!image_bins.is_empty()).then(|| {
            let spectra: Vec<Vec<Complex32>> = window
                .par_iter()
                .map(|samples| {
                    let mut buffer: Vec<Complex32> = samples.iter().zip(&window_coefficients).map(|(s, c)| s * c).collect();
                    image_fft.process(&mut buffer);
                    image_bins.iter().map(|(b, _)| buffer[*b]).collect()
                })
                .collect();
            let fields: Vec<Vec<Complex32>> = (0..image_bins.len())
                .map(|k| spectra.iter().map(|s| s[k]).collect())
                .collect();
            let groups: Vec<(f64, Vec<&[Complex32]>)> =
                image_bins.iter().zip(&fields).map(|((_, f), field)| (*f, vec![field.as_slice()])).collect();
            beamform(&positions, &groups, plan.products.images.as_ref().unwrap().size)
        });

        if let Some(writer) = &writer {
            writer
                .write(n, &window, &tdoa_result, image.as_deref())
                .map_err(|e| format!("writing {output_name}: {e}"))?;
        }
        for (rows, (m, e)) in tdoa_rows.iter_mut().zip(tdoa_result) {
            rows.push((m.delay_s, e, m.snr));
        }
        completed = n + 1;
        on_progress(JobState::Running, completed);
        if !more {
            last_window = Some(window);
            break;
        }
    }
    if let Some(writer) = writer {
        writer.finish(completed).map_err(|e| format!("finalising {output_name}: {e}"))?;
    }

    let tdoa_summary = plan
        .products
        .tdoa
        .then(|| {
            tdoa_rows
                .iter()
                .zip(&plan.calibrator_names)
                .map(|(rows, name)| summarise_tdoa(name, rows, plan.products.reference_antenna))
                .collect()
        });
    let images = plan.products.images.as_ref().map(|img| ImageSummary {
        frequency: img.frequency,
        bandwidth: img.bandwidth,
        bins: image_bins.len(),
        size: img.size,
    });
    let total_s = started.elapsed().as_secs_f64();
    let size_bytes = plan.output.as_ref().and_then(|p| std::fs::metadata(p).ok()).map_or(0, |m| m.len());
    let file = plan.output.as_ref().and_then(|p| p.file_name()).map(|f| f.to_string_lossy().into_owned());
    let summary = PipelineSummary {
        file,
        size_bytes,
        integrations: completed,
        requested_integrations: n_int,
        sky_frame: plan.sky_frame,
        products: plan.products.clone(),
        total_s,
        window_s: window_s.clone(),
        tdoa: tdoa_summary,
        images,
    };

    let last_window = last_window.ok_or("the pipeline produced no output")?;
    let loop_s = total_s;
    let run = accumulator.finish(plan.base, last_window, window_s, 0.0, loop_s, total_s);
    Ok(PipelineOutcome { summary, run })
}

fn summarise_tdoa(calibrator: &str, rows: &[(Vec<f64>, Vec<f64>, Vec<f32>)], reference: usize) -> TdoaSummary {
    let rms = |(m, e, _): &(Vec<f64>, Vec<f64>, Vec<f32>)| {
        let (sum, count) = m
            .iter()
            .zip(e)
            .enumerate()
            .filter(|(i, _)| *i != reference)
            .fold((0.0, 0usize), |(s, c), (_, (m, e))| (s + (m - e).powi(2), c + 1));
        (sum / count.max(1) as f64).sqrt()
    };
    // Integrations with the calibrator off are NaN and left out of the overall figure.
    let rms_s: Vec<f64> = rows.iter().map(rms).collect();
    let on: Vec<f64> = rms_s.iter().copied().filter(|r| r.is_finite()).collect();
    let overall = if on.is_empty() { f64::NAN } else { (on.iter().map(|r| r * r).sum::<f64>() / on.len() as f64).sqrt() };
    TdoaSummary {
        calibrator: calibrator.to_string(),
        reference_antenna: reference,
        rms_s,
        median_snr: rows
            .iter()
            .map(|(_, _, snr)| {
                let mut v: Vec<f32> = snr.iter().copied().filter(|x| x.is_finite()).collect();
                if v.is_empty() {
                    return f32::NAN;
                }
                let mid = v.len() / 2;
                *v.select_nth_unstable_by(mid, |a, b| a.total_cmp(b)).1
            })
            .collect(),
        overall_rms_s: overall,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The rotating frame turns the sky opposite to the observer: about north, the eastern horizon rises.
    #[test]
    fn rotation_basis_turns_the_sky() {
        let quarter = rotation_basis([0.0, 1.0, 0.0], -std::f64::consts::FRAC_PI_2);
        let east = quarter.to_local([1.0, 0.0, 0.0]);
        assert!((east[2] - 1.0).abs() < 1e-12, "east horizon should reach the zenith: {east:?}");
        let b = rotation_basis([0.6, 0.0, 0.8], 0.7);
        for (u, v) in [(b.east, b.north), (b.north, b.up), (b.up, b.east)] {
            assert!(u.iter().zip(v).map(|(a, b)| a * b).sum::<f64>().abs() < 1e-12);
        }
        assert_eq!(b.to_local([0.6, 0.0, 0.8]).map(|x| (x * 1e9).round() / 1e9), [0.6, 0.0, 0.8]);
    }

    /// A calibrator's TDOA band is its transmit band within the bandpass, or the bandpass when it misses it.
    #[test]
    fn transmit_band_follows_the_transmitter() {
        let a = ArrayDto {
            sample_frequency: 120e6,
            downmix_frequency: 0.0,
            bandpass: [15e6, 45e6],
            sample_window_size: 4096,
            system_noise_intensity: 0.0,
            antenna_positions: Vec::new(),
        };
        let tx = |frequency: f64, rate: f64, bandwidth: Option<f64>| {
            Transmitter::new(frequency, rate, 1.0, vec![Complex32::new(1.0, 0.0)], bandwidth, 0.0)
        };
        let bin = |f: f64| f * 4096.0 / 120e6;
        let whole = (bin(15e6).ceil() as usize, bin(45e6).floor() as usize);
        // 35 MHz ± 2.5 MHz, widened by a bin on each side.
        assert_eq!(transmit_band(&tx(35e6, 5e6, None), &a), (bin(32.5e6).floor() as usize - 1, bin(37.5e6).ceil() as usize + 1));
        // A narrower filter narrows it; a wider one does not widen it past the sample rate.
        assert_eq!(transmit_band(&tx(35e6, 5e6, Some(1e6)), &a), (bin(34.5e6).floor() as usize - 1, bin(35.5e6).ceil() as usize + 1));
        assert_eq!(transmit_band(&tx(35e6, 5e6, Some(50e6)), &a), transmit_band(&tx(35e6, 5e6, None), &a));
        // Clipped to the bandpass, and the whole bandpass for a transmitter outside it.
        assert_eq!(transmit_band(&tx(30e6, 60e6, None), &a), whole);
        assert_eq!(transmit_band(&tx(80e6, 5e6, None), &a), whole);
    }

    /// Band-limited noise delayed by known fractional amounts is recovered to well below a sample.
    #[test]
    fn tdoa_recovers_known_delays() {
        let (w, fs) = (4096usize, 120e6);
        let band = (512usize, 1536usize);
        let delays = [0.0, 3.25e-8, -1.7e-7, 4.01e-7];
        let mut rng = 12345u64;
        let mut next = || {
            rng ^= rng << 13;
            rng ^= rng >> 7;
            rng ^= rng << 17;
            (rng as f64 / u64::MAX as f64) * std::f64::consts::TAU
        };
        let phases: Vec<f64> = (0..w).map(|_| next()).collect();
        let inverse = FftPlanner::<f32>::new().plan_fft_inverse(w);
        let window: Vec<Vec<Complex32>> = delays
            .iter()
            .map(|tau| {
                let mut spectrum = vec![Complex32::new(0.0, 0.0); w];
                for k in band.0..=band.1 {
                    let f = k as f64 * fs / w as f64;
                    spectrum[k] = Complex32::from_polar(1.0, (phases[k] - std::f64::consts::TAU * f * tau) as f32);
                }
                inverse.process(&mut spectrum);
                spectrum
            })
            .collect();
        let est = TdoaEstimator::new(w, fs, band, 5e-7, 0).estimate(&window);
        for (got, want) in est.delay_s.iter().zip(delays) {
            assert!((got - want).abs() < 0.05 / fs, "estimated {got:e}, expected {want:e}");
        }
        assert!(est.snr[1] > 10.0);
    }
}
