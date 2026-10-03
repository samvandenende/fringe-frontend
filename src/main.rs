//! Web frontend for the fringe radio interferometer simulator.
//!
//! Serves the static UI from `web/` and a small JSON API that runs fringe simulations in
//! the background and exposes derived data products (spectra, waterfalls, sky images).

mod analysis;
mod gsm;
mod job;
mod pycode;

use std::net::SocketAddr;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::Instant;

use axum::extract::{DefaultBodyLimit, Path, Query, State};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use clap::Parser;
use serde::Deserialize;
use tower_http::services::ServeDir;

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
    /// Python array layouts (needs numpy).
    #[arg(long, default_value = "python3")]
    python: String,

    /// Allow running Python layout code when bound to a non-loopback address. Anyone who can
    /// reach the server can then execute code as your user.
    #[arg(long)]
    allow_remote_code: bool,
}

struct AppState {
    status: Mutex<JobStatus>,
    cancel: AtomicBool,
    result: RwLock<Option<Arc<RunResult>>>,
    run_counter: AtomicU64,
    python: String,
    gsm_available: bool,
    /// Why Python layouts are unavailable, if they are.
    layout_disabled: Option<String>,
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
        "python_layout": state.layout_disabled.is_none(),
        "python_layout_disabled": state.layout_disabled,
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

async fn python_layout(
    State(state): State<Shared>,
    headers: axum::http::HeaderMap,
    Json(request): Json<pycode::LayoutRequest>,
) -> Response {
    if let Some(reason) = &state.layout_disabled {
        return error(StatusCode::FORBIDDEN, reason.clone());
    }
    let host = headers.get(header::HOST).and_then(|h| h.to_str().ok()).unwrap_or("");
    if !state.allow_remote_code && !pycode::is_loopback_host(host) {
        return error(StatusCode::FORBIDDEN, "Python layouts are only accepted via localhost");
    }
    match pycode::run(&state.python, request).await {
        Ok(response) => Json(response).into_response(),
        Err(e) => error(StatusCode::BAD_REQUEST, e),
    }
}

async fn start_run(State(state): State<Shared>, Json(request): Json<RunRequest>) -> Response {
    let request = match request.validate() {
        Ok(r) => r,
        Err(e) => return error(StatusCode::BAD_REQUEST, e),
    };

    let run_id = {
        let mut status = state.status.lock().unwrap();
        if status.state.is_active() {
            return error(StatusCode::CONFLICT, "a simulation is already running");
        }
        let run_id = state.run_counter.fetch_add(1, Ordering::Relaxed) + 1;
        *status = JobStatus {
            run_id,
            state: JobState::Initializing,
            completed: 0,
            total: request.integrations,
            elapsed_s: 0.0,
            message: None,
        };
        run_id
    };
    state.cancel.store(false, Ordering::Relaxed);

    let worker_state = state.clone();
    std::thread::spawn(move || {
        let state = worker_state;
        let started = Instant::now();
        let outcome = catch_unwind(AssertUnwindSafe(|| {
            job::execute(request, &state.cancel, |job_state, completed| {
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
            Ok(result) => {
                status.state = if result.summary.integrations < result.summary.requested_integrations {
                    JobState::Cancelled
                } else {
                    JobState::Finished
                };
                status.completed = result.summary.integrations;
                *state.result.write().unwrap() = Some(Arc::new(result));
            }
            Err(message) => {
                status.state = JobState::Failed;
                status.message = Some(message);
            }
        }
    });

    (StatusCode::ACCEPTED, Json(serde_json::json!({ "run_id": run_id }))).into_response()
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

    let layout_disabled = if !args.bind.ip().is_loopback() && !args.allow_remote_code {
        Some(format!(
            "Python layouts are disabled because the server listens on {}; restart with --allow-remote-code to enable them",
            args.bind
        ))
    } else if !pycode::available(&args.python).await {
        Some(format!("Python layouts need numpy, which {} does not have (see --python)", args.python))
    } else {
        None
    };
    if let Some(reason) = &layout_disabled {
        eprintln!("note: {reason}");
    }

    let state = Arc::new(AppState {
        status: Mutex::new(JobStatus::idle()),
        cancel: AtomicBool::new(false),
        result: RwLock::new(None),
        run_counter: AtomicU64::new(0),
        python: args.python,
        gsm_available,
        layout_disabled,
        allow_remote_code: args.allow_remote_code,
    });

    let api = Router::new()
        .route("/info", get(info))
        .route("/sky/gsm", post(gsm_sky))
        .route("/array/python", post(python_layout))
        .route("/run", post(start_run))
        .route("/run/status", get(run_status))
        .route("/run/cancel", post(cancel_run))
        .route("/run/summary", get(run_summary))
        .route("/run/antenna/{index}", get(run_antenna))
        .route("/run/image", get(run_image))
        .layer(DefaultBodyLimit::max(512 << 20));

    let app = Router::new()
        .nest("/api", api)
        .fallback_service(ServeDir::new(&args.web_dir))
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(args.bind)
        .await
        .unwrap_or_else(|e| panic!("failed to bind {}: {e}", args.bind));
    println!("fringe frontend running at http://{}", args.bind);
    axum::serve(listener, app).await.expect("server error");
}
