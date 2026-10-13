//! Web frontend for the fringe radio interferometer simulator.
//!
//! Serves the static UI from `web/` and a small JSON API that runs fringe simulations in
//! the background and exposes derived data products (spectra, waterfalls, sky images).

mod analysis;
mod gsm;
mod job;
mod lunar;
mod pipeline;
mod pycode;

use std::net::SocketAddr;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::Instant;

use axum::extract::{DefaultBodyLimit, Path, Query, State};
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use clap::Parser;
use serde::Deserialize;
use tower_http::services::ServeDir;
use tower_http::set_header::SetResponseHeader;

use analysis::RunResult;
use job::{JobState, JobStatus, RunRequest};

#[derive(Parser, Debug)]
struct Args {
    /// Address to serve the frontend on.
    #[arg(long, short, default_value = "127.0.0.1:8080")]
    bind: SocketAddr,

    /// Directory containing the static frontend.
    #[arg(long, default_value = concat!(env!("CARGO_MANIFEST_DIR"), "/web"))]
    web_dir: PathBuf,

    /// Python interpreter used for GSM2016 sky models (needs pygdsm, healpy, astropy) and
    /// user-written Python array layouts, calibrator trajectories and transmit buffers (needs numpy).
    #[arg(long, default_value = "python3")]
    python: String,

    /// Allow running user-written Python code when bound to a non-loopback address. Anyone who can
    /// reach the server can then execute code as your user.
    #[arg(long)]
    allow_remote_code: bool,

    /// Directory where pipeline runs write their HDF5 output.
    #[arg(long, default_value = concat!(env!("CARGO_MANIFEST_DIR"), "/output"))]
    output_dir: PathBuf,
}

struct AppState {
    status: Mutex<JobStatus>,
    cancel: AtomicBool,
    result: RwLock<Option<Arc<RunResult>>>,
    pipeline: RwLock<Option<Arc<pipeline::PipelineSummary>>>,
    run_counter: AtomicU64,
    output_dir: PathBuf,
    python: String,
    gsm_available: bool,
    /// Why user-written Python code is unavailable, if it is.
    python_disabled: Option<String>,
    allow_remote_code: bool,
}

type Shared = Arc<AppState>;

fn error(status: StatusCode, message: impl Into<String>) -> Response {
    (status, Json(serde_json::json!({ "error": message.into() }))).into_response()
}

fn panic_message(payload: &(dyn std::any::Any + Send)) -> String {
    payload
        .downcast_ref::<&str>()
        .map(|s| s.to_string())
        .or_else(|| payload.downcast_ref::<String>().cloned())
        .unwrap_or_else(|| "unknown panic".to_string())
}

async fn info(State(state): State<Shared>) -> Response {
    Json(serde_json::json!({
        "version": env!("CARGO_PKG_VERSION"),
        "threads": rayon::current_num_threads(),
        "gsm": state.gsm_available,
        "python_code": state.python_disabled.is_none(),
        "python_code_disabled": state.python_disabled,
    }))
    .into_response()
}

async fn gsm_sky(State(state): State<Shared>, Json(request): Json<gsm::GsmRequest>) -> Response {
    if !state.gsm_available {
        return error(
            StatusCode::SERVICE_UNAVAILABLE,
            format!("pygdsm, healpy and astropy are not available to {}", state.python),
        );
    }
    match gsm::generate(&state.python, request).await {
        Ok(response) => Json(response).into_response(),
        Err(e) => error(StatusCode::BAD_REQUEST, e),
    }
}

async fn python_code(
    State(state): State<Shared>,
    headers: axum::http::HeaderMap,
    Json(request): Json<pycode::CodeRequest>,
) -> Response {
    if let Some(reason) = &state.python_disabled {
        return error(StatusCode::FORBIDDEN, reason.clone());
    }
    let host = headers.get(header::HOST).and_then(|h| h.to_str().ok()).unwrap_or("");
    if !state.allow_remote_code && !pycode::is_loopback_host(host) {
        return error(StatusCode::FORBIDDEN, "Python code is only accepted via localhost");
    }
    match pycode::run(&state.python, request).await {
        Ok(response) => Json(response).into_response(),
        Err(e) => error(StatusCode::BAD_REQUEST, e),
    }
}

/// Output of a background job: the run analysis shown in the Signals/Imaging tabs, plus the
/// pipeline summary for pipeline jobs.
struct JobOutput {
    run: RunResult,
    pipeline: Option<pipeline::PipelineSummary>,
}

type Progress<'a> = &'a mut dyn FnMut(JobState, usize);

/// Claims the single job slot and runs `work` on a background thread, publishing its progress
/// and results. fringe panics on some invalid inputs, so panics are reported as failures.
fn spawn_job<W>(state: &Shared, kind: &'static str, total: usize, work: W) -> Response
where
    W: FnOnce(&AtomicBool, Progress) -> Result<JobOutput, String> + Send + 'static,
{
    let run_id = {
        let mut status = state.status.lock().unwrap();
        if status.state.is_active() {
            return error(StatusCode::CONFLICT, "a simulation is already running");
        }
        let run_id = state.run_counter.fetch_add(1, Ordering::Relaxed) + 1;
        *status = JobStatus {
            run_id,
            kind,
            state: JobState::Initializing,
            completed: 0,
            total,
            elapsed_s: 0.0,
            message: None,
        };
        run_id
    };
    state.cancel.store(false, Ordering::Relaxed);

    let state = state.clone();
    std::thread::spawn(move || {
        let started = Instant::now();
        let outcome = catch_unwind(AssertUnwindSafe(|| {
            work(&state.cancel, &mut |job_state, completed| {
                let mut status = state.status.lock().unwrap();
                status.state = job_state;
                status.completed = completed;
                status.elapsed_s = started.elapsed().as_secs_f64();
            })
        }))
        .unwrap_or_else(|payload| Err(format!("simulation panicked: {}", panic_message(&*payload))));

        let mut status = state.status.lock().unwrap();
        status.elapsed_s = started.elapsed().as_secs_f64();
        match outcome {
            Ok(output) => {
                let summary = &output.run.summary;
                status.state = if summary.integrations < summary.requested_integrations {
                    JobState::Cancelled
                } else {
                    JobState::Finished
                };
                status.completed = summary.integrations;
                *state.result.write().unwrap() = Some(Arc::new(output.run));
                if let Some(p) = output.pipeline {
                    *state.pipeline.write().unwrap() = Some(Arc::new(p));
                }
            }
            Err(message) => {
                status.state = JobState::Failed;
                status.message = Some(message);
            }
        }
    });

    (StatusCode::ACCEPTED, Json(serde_json::json!({ "run_id": run_id }))).into_response()
}

async fn start_run(State(state): State<Shared>, Json(request): Json<RunRequest>) -> Response {
    let request = match request.validate() {
        Ok(r) => r,
        Err(e) => return error(StatusCode::BAD_REQUEST, e),
    };
    let total = request.integrations;
    spawn_job(&state, "simulation", total, move |cancel, progress| {
        job::execute(request, cancel, progress).map(|run| JobOutput { run, pipeline: None })
    })
}

async fn start_pipeline(State(state): State<Shared>, Json(request): Json<pipeline::PipelineRequest>) -> Response {
    if state.status.lock().unwrap().state.is_active() {
        return error(StatusCode::CONFLICT, "a simulation is already running");
    }
    let output_dir = state.output_dir.clone();
    let plan = match tokio::task::spawn_blocking(move || request.validate(&output_dir)).await {
        Ok(Ok(plan)) => plan,
        Ok(Err(e)) => return error(StatusCode::BAD_REQUEST, e),
        Err(e) => return error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    };
    let total = plan.integrations();
    spawn_job(&state, "pipeline", total, move |cancel, progress| {
        pipeline::execute(plan, cancel, progress).map(|o| JobOutput { run: o.run, pipeline: Some(o.summary) })
    })
}

async fn pipeline_result(State(state): State<Shared>) -> Response {
    match state.pipeline.read().unwrap().clone() {
        Some(summary) => Json(&*summary).into_response(),
        None => error(StatusCode::NOT_FOUND, "no pipeline result available"),
    }
}

/// HDF5 files in the output directory, newest first.
async fn pipeline_outputs(State(state): State<Shared>) -> Response {
    let mut files = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&state.output_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().is_some_and(|e| e == "h5")
                && let Ok(meta) = entry.metadata()
            {
                let modified = meta
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map_or(0.0, |d| d.as_secs_f64());
                files.push((modified, entry.file_name().to_string_lossy().into_owned(), meta.len()));
            }
        }
    }
    files.sort_by(|a, b| b.0.total_cmp(&a.0));
    let files: Vec<_> = files
        .into_iter()
        .map(|(modified, name, size)| serde_json::json!({ "name": name, "size_bytes": size, "modified": modified }))
        .collect();
    Json(serde_json::json!({ "directory": state.output_dir, "files": files })).into_response()
}

async fn run_status(State(state): State<Shared>) -> Response {
    Json(state.status.lock().unwrap().clone()).into_response()
}

async fn cancel_run(State(state): State<Shared>) -> Response {
    state.cancel.store(true, Ordering::Relaxed);
    StatusCode::NO_CONTENT.into_response()
}

fn current_result(state: &AppState) -> Option<Arc<RunResult>> {
    state.result.read().unwrap().clone()
}

fn no_result() -> Response {
    error(StatusCode::NOT_FOUND, "no simulation result available")
}

async fn run_summary(State(state): State<Shared>) -> Response {
    match current_result(&state) {
        Some(result) => Json(&result.summary).into_response(),
        None => no_result(),
    }
}

async fn run_antenna(State(state): State<Shared>, Path(index): Path<usize>) -> Response {
    let Some(result) = current_result(&state) else {
        return no_result();
    };
    match result.antenna(index) {
        Some(data) => Json(data).into_response(),
        None => error(StatusCode::NOT_FOUND, "antenna index out of range"),
    }
}

#[derive(Deserialize)]
struct ImageQuery {
    channel: usize,
    #[serde(default = "default_image_size")]
    size: usize,
}

fn default_image_size() -> usize {
    128
}

async fn run_image(State(state): State<Shared>, Query(query): Query<ImageQuery>) -> Response {
    let Some(result) = current_result(&state) else {
        return no_result();
    };
    if !(16..=512).contains(&query.size) {
        return error(StatusCode::BAD_REQUEST, "image size must be between 16 and 512");
    }
    let image = tokio::task::spawn_blocking(move || result.image(query.channel, query.size)).await;
    match image {
        Ok(Some(image)) => Json(&*image).into_response(),
        Ok(None) => error(StatusCode::NOT_FOUND, "channel out of range"),
        Err(e) => error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

#[tokio::main]
async fn main() {
    let args = Args::parse();

    let gsm_available = gsm::available(&args.python).await;
    if !gsm_available {
        eprintln!(
            "note: GSM2016 sky generation disabled ({} lacks pygdsm/healpy/astropy; see --python)",
            args.python
        );
    }

    let python_disabled = if !args.bind.ip().is_loopback() && !args.allow_remote_code {
        Some(format!(
            "Python code is disabled because the server listens on {}; restart with --allow-remote-code to enable it",
            args.bind
        ))
    } else if !pycode::available(&args.python).await {
        Some(format!("Python code needs numpy, which {} does not have (see --python)", args.python))
    } else {
        None
    };
    if let Some(reason) = &python_disabled {
        eprintln!("note: {reason}");
    }

    let state = Arc::new(AppState {
        status: Mutex::new(JobStatus::idle()),
        cancel: AtomicBool::new(false),
        result: RwLock::new(None),
        pipeline: RwLock::new(None),
        run_counter: AtomicU64::new(0),
        output_dir: args.output_dir.clone(),
        python: args.python,
        gsm_available,
        python_disabled,
        allow_remote_code: args.allow_remote_code,
    });

    let api = Router::new()
        .route("/info", get(info))
        .route("/sky/gsm", post(gsm_sky))
        .route("/python", post(python_code))
        .route("/run", post(start_run))
        .route("/run/status", get(run_status))
        .route("/run/cancel", post(cancel_run))
        .route("/run/summary", get(run_summary))
        .route("/run/antenna/{index}", get(run_antenna))
        .route("/run/image", get(run_image))
        .route("/pipeline/run", post(start_pipeline))
        .route("/pipeline/result", get(pipeline_result))
        .route("/pipeline/outputs", get(pipeline_outputs))
        .nest_service("/pipeline/files", ServeDir::new(&args.output_dir))
        .layer(DefaultBodyLimit::max(512 << 20));

    let app = Router::new()
        .nest("/api", api)
        // Revalidate the frontend on every load (a cheap 304 when unchanged): without a cache
        // header, browsers reuse long-unchanged files such as data/default_sky.csv for hours
        // after they change, mixing stale data or modules with fresh ones.
        .fallback_service(SetResponseHeader::overriding(
            ServeDir::new(&args.web_dir),
            header::CACHE_CONTROL,
            HeaderValue::from_static("no-cache"),
        ))
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(args.bind)
        .await
        .unwrap_or_else(|e| panic!("failed to bind {}: {e}", args.bind));
    println!("fringe frontend running at http://{}", args.bind);
    axum::serve(listener, app).await.expect("server error");
}
