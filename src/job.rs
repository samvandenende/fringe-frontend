//! Simulation jobs: request parsing/validation and the integration loop that drives fringe.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;

use fringe::{Array, Calibrator, Simulation, Source, Vec3};
use serde::{Deserialize, Serialize};

use crate::analysis::{Accumulator, RunResult, WindowFunction};

/// Upper bound on memory used for the per-integration E-field store kept for imaging.
const MAX_CHANNEL_STORE_BYTES: usize = 2 << 30;

/// Array model, in the same shape as fringe's array JSON files.
#[derive(Deserialize, Serialize, Clone)]
pub struct ArrayDto {
    pub sample_frequency: f64,
    pub downmix_frequency: f64,
    pub bandpass: [f64; 2],
    pub sample_window_size: usize,
    pub system_noise_intensity: f64,
    pub antenna_positions: Vec<Vec3>,
}

/// Sky model source, in the same shape as a row of fringe's sources CSV files.
#[derive(Deserialize, Clone)]
pub struct SourceDto {
    pub right_ascension: f64,
    pub declination: f64,
    pub reference_frequency: f64,
    pub reference_intensity: f64,
    pub spectral_index: f64,
}

/// Calibrator, in the same shape as fringe's calibrator JSON files.
#[derive(Deserialize, Clone)]
pub struct CalibratorDto {
    pub position: Vec3,
    pub intensity: f64,
}

#[derive(Deserialize, Clone)]
pub struct AnalysisDto {
    pub window: WindowFunction,
    /// Number of frequency channels across the bandpass for which E-fields are kept for imaging.
    pub channels: usize,
}

#[derive(Deserialize, Clone)]
pub struct RunRequest {
    pub runtime: String,
    pub frequency_resolution: usize,
    pub rng_seed: Option<u64>,
    pub integrations: usize,
    pub array: ArrayDto,
    pub sources: Vec<SourceDto>,
    pub calibrator: Option<CalibratorDto>,
    pub analysis: AnalysisDto,
}

/// A request that passed validation and can be handed to fringe without tripping its asserts.
pub struct ValidatedRequest {
    pub runtime: String,
    pub frequency_resolution: usize,
    pub rng_seed: u64,
    pub integrations: usize,
    pub array_dto: ArrayDto,
    pub array: Array,
    pub sources: Vec<Source>,
    pub calibrator: Option<Calibrator>,
    pub analysis: AnalysisDto,
}

#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum JobState {
    Idle,
    Initializing,
    Running,
    Finished,
    Cancelled,
    Failed,
}

impl JobState {
    pub fn is_active(self) -> bool {
        matches!(self, JobState::Initializing | JobState::Running)
    }
}

#[derive(Serialize, Clone)]
pub struct JobStatus {
    pub run_id: u64,
    pub state: JobState,
    pub completed: usize,
    pub total: usize,
    pub elapsed_s: f64,
    pub message: Option<String>,
}

impl JobStatus {
    pub fn idle() -> Self {
        JobStatus {
            run_id: 0,
            state: JobState::Idle,
            completed: 0,
            total: 0,
            elapsed_s: 0.0,
            message: None,
        }
    }
}

fn check(condition: bool, message: &str) -> Result<(), String> {
    if condition {
        Ok(())
    } else {
        Err(message.to_string())
    }
}

impl RunRequest {
    /// Validates the request, mirroring the asserts fringe would otherwise panic on.
    pub fn validate(self) -> Result<ValidatedRequest, String> {
        let runtime = self.runtime.trim().to_ascii_lowercase();
        check(
            runtime == "cpu" || runtime == "gpu",
            "runtime must be 'cpu' or 'gpu'",
        )?;
        check(
            self.frequency_resolution.is_power_of_two() && self.frequency_resolution <= 64,
            "frequency resolution must be a power of two between 1 and 64",
        )?;
        check(
            (1..=100_000).contains(&self.integrations),
            "integrations must be between 1 and 100000",
        )?;

        let a = &self.array;
        check(
            !a.antenna_positions.is_empty(),
            "the array must contain at least one antenna",
        )?;
        check(
            a.antenna_positions.len() <= 65_536,
            "the array may contain at most 65536 antennas",
        )?;
        check(
            a.antenna_positions
                .iter()
                .all(|p| p.x.is_finite() && p.y.is_finite() && p.z.is_finite()),
            "antenna positions must be finite",
        )?;
        check(
            a.sample_frequency.is_finite() && a.sample_frequency > 0.0,
            "sample frequency must be positive",
        )?;
        check(
            a.downmix_frequency.is_finite() && a.downmix_frequency >= 0.0,
            "downmix frequency must be non-negative",
        )?;
        check(
            a.bandpass[0].is_finite() && a.bandpass[0] > 0.0 && a.bandpass[0] < a.bandpass[1],
            "bandpass f_min must be positive and smaller than f_max",
        )?;
        check(
            a.bandpass[1].is_finite() && a.bandpass[1] <= a.sample_frequency / 2.0,
            "bandpass f_max must be at most half the sample frequency (Nyquist)",
        )?;
        check(
            a.sample_window_size.is_power_of_two() && (16..=65_536).contains(&a.sample_window_size),
            "sample window size must be a power of two between 16 and 65536",
        )?;
        check(
            a.system_noise_intensity.is_finite() && a.system_noise_intensity >= 0.0,
            "system noise intensity must be non-negative",
        )?;

        let sources = self
            .sources
            .iter()
            .enumerate()
            .map(|(i, s)| {
                check(
                    s.right_ascension.is_finite() && s.declination.is_finite(),
                    &format!("source {i}: coordinates must be finite"),
                )?;
                check(
                    s.reference_frequency.is_finite() && s.reference_frequency > 0.0,
                    &format!("source {i}: reference frequency must be positive"),
                )?;
                check(
                    s.reference_intensity.is_finite() && s.reference_intensity >= 0.0,
                    &format!("source {i}: reference intensity must be non-negative"),
                )?;
                check(
                    s.spectral_index.is_finite(),
                    &format!("source {i}: spectral index must be finite"),
                )?;
                Ok(Source::new(
                    Vec3::from_ra_dec(s.right_ascension, s.declination),
                    s.reference_frequency,
                    s.reference_intensity,
                    s.spectral_index,
                ))
            })
            .collect::<Result<Vec<_>, String>>()?;

        let calibrator = match &self.calibrator {
            Some(c) => {
                check(
                    c.intensity.is_finite() && c.intensity >= 0.0,
                    "calibrator intensity must be non-negative",
                )?;
                check(
                    a.antenna_positions
                        .iter()
                        .all(|p| (c.position - *p).norm() > 0.0),
                    "the calibrator may not coincide with an antenna",
                )?;
                Some(Calibrator::new(c.position, c.intensity))
            }
            None => None,
        };

        check(
            (1..=1024).contains(&self.analysis.channels),
            "imaging channels must be between 1 and 1024",
        )?;
        let store_bytes = self.integrations
            * self.analysis.channels
            * a.antenna_positions.len()
            * std::mem::size_of::<num_complex::Complex32>();
        check(
            store_bytes <= MAX_CHANNEL_STORE_BYTES,
            "integrations × imaging channels × antennas is too large to keep in memory; reduce one of them",
        )?;

        // fringe's Array constructor is Python-facing, but the type is serde-deserializable
        // from exactly the JSON layout of its array files.
        let array: Array = serde_json::to_value(&self.array)
            .and_then(serde_json::from_value)
            .map_err(|e| format!("invalid array: {e}"))?;

        Ok(ValidatedRequest {
            runtime,
            frequency_resolution: self.frequency_resolution,
            rng_seed: self.rng_seed.unwrap_or_else(rand::random),
            integrations: self.integrations,
            array_dto: self.array,
            array,
            sources,
            calibrator,
            analysis: self.analysis,
        })
    }
}

/// Runs the simulation for the requested number of integrations.
///
/// `start`/`finish` are pipelined as in fringe's examples so the analysis of one
/// window overlaps with the simulation of the next. Returns the partial result if
/// cancelled after at least one window has completed.
pub fn execute(
    req: ValidatedRequest,
    cancel: &AtomicBool,
    mut on_progress: impl FnMut(JobState, usize),
) -> Result<RunResult, String> {
    let started = Instant::now();
    on_progress(JobState::Initializing, 0);

    let mut simulation = Simulation::new(
        req.runtime.clone(),
        req.array.clone(),
        req.frequency_resolution,
        Some(req.rng_seed),
    );
    simulation.set_sources(req.sources.clone());
    if let Some(calibrator) = &req.calibrator {
        simulation.set_calibrator(calibrator.clone());
    }
    let init_s = started.elapsed().as_secs_f64();

    let mut accumulator = Accumulator::new(&req);
    let mut window_times = Vec::with_capacity(req.integrations);
    let mut last_window = None;

    let loop_started = Instant::now();
    let mut window_started = Instant::now();
    simulation.start();
    on_progress(JobState::Running, 0);
    for n in 0..req.integrations {
        let window = simulation.finish();
        window_times.push(window_started.elapsed().as_secs_f64());
        window_started = Instant::now();

        let more = n + 1 < req.integrations && !cancel.load(Ordering::Relaxed);
        if more {
            simulation.start();
        }
        accumulator.add(&window);
        on_progress(JobState::Running, n + 1);
        if !more {
            last_window = Some(window);
            break;
        }
    }

    let total_s = started.elapsed().as_secs_f64();
    let loop_s = loop_started.elapsed().as_secs_f64();
    let last_window = last_window.ok_or("simulation produced no output")?;
    Ok(accumulator.finish(req, last_window, window_times, init_s, loop_s, total_s))
}
