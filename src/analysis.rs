//! Derived data products computed from fringe's time-domain antenna samples.
//!
//! Power spectra are normalised so that, for a stationary signal, the expected value of a
//! bin equals the per-bin intensity fringe synthesises (`gain * I(f)` for sources,
//! `noise / A_eff(f)` for system noise). This lets the frontend overlay the analytic model.

use std::collections::HashMap;
use std::f64::consts::TAU;
use std::sync::{Arc, Mutex};

use fringe::Vec3;
use num_complex::Complex32;
use rayon::prelude::*;
use rustfft::{Fft, FftPlanner};
use serde::{Deserialize, Serialize};

use crate::job::{ArrayDto, ValidatedRequest};

/// Speed of light in vacuum (m/s), as used by fringe.
const C: f64 = 299_792_458.0;
/// Maximum number of frequency columns in the waterfall.
const WATERFALL_MAX_COLS: usize = 1024;

#[derive(Deserialize, Serialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum WindowFunction {
    None,
    Hann,
    Blackman,
}

impl WindowFunction {
    fn coefficients(self, n: usize) -> Vec<f32> {
        (0..n)
            .map(|i| {
                let x = TAU * i as f64 / n as f64;
                (match self {
                    WindowFunction::None => 1.0,
                    WindowFunction::Hann => 0.5 - 0.5 * x.cos(),
                    WindowFunction::Blackman => 0.42 - 0.5 * x.cos() + 0.08 * (2.0 * x).cos(),
                }) as f32
            })
            .collect()
    }
}

#[derive(Serialize, Clone)]
pub struct Channel {
    /// Bin index in the (unshifted) FFT of a sample window.
    pub bin: usize,
    /// Physical sky frequency in Hz (baseband frequency plus downmix frequency).
    pub frequency: f64,
}

#[derive(Serialize)]
pub struct Timing {
    pub init_s: f64,
    pub loop_s: f64,
    pub total_s: f64,
    /// Wall time between consecutive completed windows.
    pub window_s: Vec<f64>,
}

#[derive(Serialize)]
pub struct Waterfall {
    pub rows: usize,
    pub cols: usize,
    /// Physical frequency of the lower edge of the first column, and column width (Hz).
    pub f0: f64,
    pub df: f64,
    /// Row-major, one row per integration: array-averaged power per column.
    pub data: Vec<f32>,
}

/// Everything about a run the frontend needs up front. Spectra are fftshifted so index `i`
/// corresponds to physical frequency `f0 + i * df`.
#[derive(Serialize)]
pub struct RunSummary {
    pub runtime: String,
    pub rng_seed: u64,
    pub frequency_resolution: usize,
    pub requested_integrations: usize,
    pub integrations: usize,
    pub antennas: usize,
    pub sources: usize,
    pub calibrator: bool,
    pub window: WindowFunction,
    pub array: ArrayDto,
    pub timing: Timing,
    pub f0: f64,
    pub df: f64,
    /// Bandpass edges as (inclusive) shifted-spectrum indices.
    pub band: [usize; 2],
    pub mean_spectrum: Vec<f32>,
    /// Mean in-band power per bin, per antenna.
    pub antenna_power: Vec<f32>,
    pub waterfall: Waterfall,
    pub channels: Vec<Channel>,
}

#[derive(Serialize)]
pub struct AntennaData {
    pub index: usize,
    pub position: Vec3,
    /// Samples of the last simulated window.
    pub re: Vec<f32>,
    pub im: Vec<f32>,
    /// Mean power spectrum over all integrations (fftshifted).
    pub spectrum: Vec<f32>,
}

#[derive(Serialize)]
pub struct Image {
    pub channel: usize,
    pub frequency: f64,
    pub size: usize,
    /// Row-major `size × size`, row 0 at m = -1, column 0 at l = -1. `null` outside the horizon.
    pub data: Vec<f32>,
    pub min: f32,
    pub max: f32,
    pub compute_s: f64,
}

pub struct RunResult {
    pub summary: RunSummary,
    antenna_spectra: Vec<f32>,
    last_window: Vec<Vec<Complex32>>,
    /// E-field per integration, channel and antenna: `[n][c][a]`.
    channel_store: Vec<Complex32>,
    positions: Vec<Vec3>,
    images: Mutex<HashMap<(usize, usize), Arc<Image>>>,
}

/// Accumulates spectra and imaging data over the integration windows of a run.
pub struct Accumulator {
    window_size: usize,
    fft: Arc<dyn Fft<f32>>,
    window: Vec<f32>,
    power_scale: f32,
    amplitude_scale: f32,
    channels: Vec<Channel>,
    band: [usize; 2],
    spectra_sum: Vec<f32>,
    waterfall_rows: Vec<Vec<f32>>,
    channel_store: Vec<Complex32>,
    integrations: usize,
}

/// Index shift between natural FFT order and fftshifted order.
fn shifted(bin: usize, n: usize) -> usize {
    (bin + n / 2) % n
}

impl Accumulator {
    pub fn new(req: &ValidatedRequest) -> Self {
        let a = &req.array_dto;
        let w = a.sample_window_size;
        let window = req.analysis.window.coefficients(w);
        let window_energy: f32 = window.iter().map(|v| v * v).sum();

        // fringe fills baseband bins ceil(f_min N / fs) ..= floor(f_max N / fs).
        let bin_min = (a.bandpass[0] * w as f64 / a.sample_frequency).ceil() as usize;
        let bin_max = ((a.bandpass[1] * w as f64 / a.sample_frequency).floor() as usize)
            .clamp(bin_min, w / 2 - 1);
        let span = bin_max - bin_min;
        let mut bins: Vec<usize> = (0..req.analysis.channels)
            .map(|c| bin_min + ((c as f64 + 0.5) * (span + 1) as f64 / req.analysis.channels as f64) as usize)
            .map(|b| b.min(bin_max))
            .collect();
        bins.dedup();
        let channels = bins
            .into_iter()
            .map(|bin| Channel {
                bin,
                frequency: bin as f64 * a.sample_frequency / w as f64 + a.downmix_frequency,
            })
            .collect();

        Accumulator {
            window_size: w,
            fft: FftPlanner::new().plan_fft_forward(w),
            window,
            power_scale: 1.0 / window_energy,
            amplitude_scale: 1.0 / window_energy.sqrt(),
            channels,
            band: [shifted(bin_min, w), shifted(bin_max, w)],
            spectra_sum: vec![0.0; a.antenna_positions.len() * w],
            waterfall_rows: Vec::with_capacity(req.integrations),
            channel_store: Vec::new(),
            integrations: 0,
        }
    }

    /// Adds one simulated window (`antennas × window_size` samples).
    pub fn add(&mut self, window: &[Vec<Complex32>]) {
        let Accumulator {
            window_size,
            fft,
            window: coefficients,
            power_scale,
            amplitude_scale,
            channels,
            spectra_sum,
            ..
        } = self;
        let w = *window_size;

        let per_antenna: Vec<(Vec<f32>, Vec<Complex32>)> = window
            .par_iter()
            .zip(spectra_sum.par_chunks_mut(w))
            .map(|(samples, sum)| {
                let mut buffer: Vec<Complex32> = samples
                    .iter()
                    .zip(coefficients.iter())
                    .map(|(s, c)| s * c)
                    .collect();
                fft.process(&mut buffer);
                let power: Vec<f32> = buffer.iter().map(|v| v.norm_sqr() * *power_scale).collect();
                for (s, p) in sum.iter_mut().zip(&power) {
                    *s += p;
                }
                let e_field = channels
                    .iter()
                    .map(|c| buffer[c.bin] * *amplitude_scale)
                    .collect();
                (power, e_field)
            })
            .collect();

        let mut mean = vec![0.0f32; w];
        for (power, _) in &per_antenna {
            for (m, p) in mean.iter_mut().zip(power) {
                *m += p;
            }
        }
        let inv = 1.0 / per_antenna.len() as f32;
        let mut row = vec![0.0f32; w];
        for (bin, m) in mean.iter().enumerate() {
            row[shifted(bin, w)] = m * inv;
        }
        self.waterfall_rows.push(row);

        for c in 0..self.channels.len() {
            self.channel_store
                .extend(per_antenna.iter().map(|(_, e_field)| e_field[c]));
        }
        self.integrations += 1;
    }

    pub fn finish(
        self,
        req: ValidatedRequest,
        last_window: Vec<Vec<Complex32>>,
        window_s: Vec<f64>,
        init_s: f64,
        loop_s: f64,
        total_s: f64,
    ) -> RunResult {
        let w = self.window_size;
        let a = &req.array_dto;
        let n_ant = a.antenna_positions.len();
        let inv_n = 1.0 / self.integrations as f32;

        // Mean spectrum per antenna, fftshifted.
        let mut antenna_spectra = vec![0.0f32; n_ant * w];
        antenna_spectra
            .par_chunks_mut(w)
            .zip(self.spectra_sum.par_chunks(w))
            .for_each(|(out, sum)| {
                for (bin, s) in sum.iter().enumerate() {
                    out[shifted(bin, w)] = s * inv_n;
                }
            });

        let [lo, hi] = self.band;
        let antenna_power = antenna_spectra
            .chunks(w)
            .map(|s| s[lo..=hi].iter().sum::<f32>() / (hi - lo + 1) as f32)
            .collect();

        let mut mean_spectrum = vec![0.0f32; w];
        for s in antenna_spectra.chunks(w) {
            for (m, v) in mean_spectrum.iter_mut().zip(s) {
                *m += v / n_ant as f32;
            }
        }

        let df = a.sample_frequency / w as f64;
        let f0 = a.downmix_frequency - a.sample_frequency / 2.0;

        let cols = w.min(WATERFALL_MAX_COLS);
        let group = w / cols;
        let waterfall = Waterfall {
            rows: self.waterfall_rows.len(),
            cols,
            f0: f0 - df / 2.0,
            df: df * group as f64,
            data: self
                .waterfall_rows
                .iter()
                .flat_map(|row| {
                    row.chunks(group)
                        .map(|g| g.iter().sum::<f32>() / group as f32)
                        .collect::<Vec<_>>()
                })
                .collect(),
        };

        RunResult {
            summary: RunSummary {
                runtime: req.runtime.clone(),
                rng_seed: req.rng_seed,
                frequency_resolution: req.frequency_resolution,
                requested_integrations: req.integrations,
                integrations: self.integrations,
                antennas: n_ant,
                sources: req.sources.len(),
                calibrator: req.calibrator.is_some(),
                window: req.analysis.window,
                array: req.array_dto.clone(),
                timing: Timing {
                    init_s,
                    loop_s,
                    total_s,
                    window_s,
                },
                f0,
                df,
                band: self.band,
                mean_spectrum,
                antenna_power,
                waterfall,
                channels: self.channels,
            },
            antenna_spectra,
            last_window,
            channel_store: self.channel_store,
            positions: req.array_dto.antenna_positions,
            images: Mutex::new(HashMap::new()),
        }
    }
}

impl RunResult {
    pub fn antenna(&self, index: usize) -> Option<AntennaData> {
        let samples = self.last_window.get(index)?;
        let w = self.summary.array.sample_window_size;
        Some(AntennaData {
            index,
            position: self.positions[index],
            re: samples.iter().map(|s| s.re).collect(),
            im: samples.iter().map(|s| s.im).collect(),
            spectrum: self.antenna_spectra[index * w..(index + 1) * w].to_vec(),
        })
    }

    /// Dirty image of the sky at an imaging channel, averaged over all integrations.
    ///
    /// fringe gives antenna `a` a source phase of `+2π f (d·r_a) / c`, so the beam steered to
    /// direction `d = (l, m, n)` is `|Σ_a E_a exp(-2πi f (d·r_a) / c)|²`. Normalised by
    /// `antennas²`, a point source then peaks at its apparent intensity `gain · I(f)`.
    pub fn image(&self, channel: usize, size: usize) -> Option<Arc<Image>> {
        let info = self.summary.channels.get(channel)?;
        if let Some(image) = self.images.lock().unwrap().get(&(channel, size)) {
            return Some(image.clone());
        }

        let started = std::time::Instant::now();
        let n_ant = self.positions.len();
        let n_chan = self.summary.channels.len();
        let n_int = self.summary.integrations;
        let k = TAU * info.frequency / C;

        let centroid = self
            .positions
            .iter()
            .fold(Vec3::new(0.0, 0.0, 0.0), |acc, p| acc + *p)
            / n_ant as f64;
        let rel: Vec<Vec3> = self.positions.iter().map(|p| *p - centroid).collect();
        let planar = rel.iter().all(|p| p.z.abs() < 1e-9);

        let coord = |i: usize| -1.0 + (i as f64 + 0.5) * 2.0 / size as f64;
        let phasors = |component: fn(&Vec3) -> f64| -> Vec<Complex32> {
            (0..size)
                .flat_map(|i| {
                    let u = coord(i);
                    rel.iter().map(move |p| {
                        let phase = -k * u * component(p);
                        Complex32::new(phase.cos() as f32, phase.sin() as f32)
                    })
                })
                .collect()
        };
        let wl = phasors(|p| p.x);
        let wm = phasors(|p| p.y);

        let norm = 1.0 / (n_int as f32 * (n_ant * n_ant) as f32);
        let data: Vec<f32> = (0..size)
            .into_par_iter()
            .flat_map_iter(|j| {
                let m = coord(j);
                let wm_row = &wm[j * n_ant..(j + 1) * n_ant];
                let mut row = vec![0.0f32; size];
                let mut steered = vec![Complex32::new(0.0, 0.0); n_ant];
                for n in 0..n_int {
                    let offset = (n * n_chan + channel) * n_ant;
                    let e_field = &self.channel_store[offset..offset + n_ant];
                    for ((s, e), w) in steered.iter_mut().zip(e_field).zip(wm_row) {
                        *s = e * w;
                    }
                    for (i, value) in row.iter_mut().enumerate() {
                        let l = coord(i);
                        let r2 = l * l + m * m;
                        if r2 > 1.0 {
                            continue;
                        }
                        let wl_row = &wl[i * n_ant..(i + 1) * n_ant];
                        let sum = if planar {
                            steered
                                .iter()
                                .zip(wl_row)
                                .fold(Complex32::new(0.0, 0.0), |acc, (s, w)| acc + s * w)
                        } else {
                            let nz = (1.0 - r2).sqrt();
                            steered.iter().zip(wl_row).zip(&rel).fold(
                                Complex32::new(0.0, 0.0),
                                |acc, ((s, w), p)| {
                                    let phase = (-k * nz * p.z) as f32;
                                    acc + s * w * Complex32::from_polar(1.0, phase)
                                },
                            )
                        };
                        *value += sum.norm_sqr();
                    }
                }
                row.into_iter().enumerate().map(move |(i, v)| {
                    let l = coord(i);
                    if l * l + m * m > 1.0 { f32::NAN } else { v * norm }
                })
            })
            .collect();

        let (min, max) = data
            .iter()
            .filter(|v| v.is_finite())
            .fold((f32::INFINITY, f32::NEG_INFINITY), |(lo, hi), &v| {
                (lo.min(v), hi.max(v))
            });
        let image = Arc::new(Image {
            channel,
            frequency: info.frequency,
            size,
            data,
            min,
            max,
            compute_s: started.elapsed().as_secs_f64(),
        });
        self.images
            .lock()
            .unwrap()
            .insert((channel, size), image.clone());
        Some(image)
    }
}
