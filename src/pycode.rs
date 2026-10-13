//! User-written Python functions (array layouts, calibrator trajectories and transmit buffers), run by
//! `scripts/python_runner.py`.
//!
//! This executes arbitrary code as the server's user, so it is only enabled when the server is
//! bound to a loopback address (or explicitly allowed), and requests must carry a loopback
//! `Host` header (against DNS rebinding) and a JSON body (which cross-site pages cannot send
//! without a CORS preflight, which this server never grants).

use std::process::Stdio;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

const RUNNER: &str = include_str!("../scripts/python_runner.py");
const TIMEOUT: Duration = Duration::from_secs(60);
const MAX_CODE_BYTES: usize = 256 * 1024;

/// What the code computes: `layout(ctx)` (antenna positions), `positions(ctx)` (one calibrator
/// state per integration) or `buffer(ctx)` (the calibrator's transmit buffer).
#[derive(Deserialize, Serialize, Clone, Copy, Default)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    #[default]
    Layout,
    Calibrator,
    Transmitter,
}

impl Kind {
    fn function(self) -> &'static str {
        match self {
            Kind::Layout => "layout()",
            Kind::Calibrator => "positions()",
            Kind::Transmitter => "buffer()",
        }
    }
}

#[derive(Deserialize, Serialize)]
pub struct CodeRequest {
    #[serde(default)]
    pub kind: Kind,
    pub code: String,
    /// Settings exposed to the function as `ctx`.
    #[serde(default)]
    pub context: serde_json::Map<String, serde_json::Value>,
}

#[derive(Serialize, Deserialize)]
pub struct CodeResponse {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub positions: Option<Vec<[f64; 3]>>,
    /// Calibrator velocity and acceleration per row, when the code returned them.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub velocity: Option<Vec<[f64; 3]>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub acceleration: Option<Vec<[f64; 3]>>,
    /// Calibrator transmit power per row (null: use the power field), when the code returned one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub power: Option<Vec<Option<f64>>>,
    /// Transmit buffer: base64 of interleaved little-endian f32 IQ samples (cf32_le).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub buffer: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default)]
    pub stdout: String,
    #[serde(default)]
    pub elapsed_s: f64,
}

/// Checks (without importing it) that numpy is installed for the interpreter.
pub async fn available(python: &str) -> bool {
    Command::new(python)
        .args(["-c", "import importlib.util, sys; sys.exit(0 if importlib.util.find_spec('numpy') else 1)"])
        .output()
        .await
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Whether a `Host` header names this machine via loopback.
pub fn is_loopback_host(host: &str) -> bool {
    let name = if let Some(rest) = host.strip_prefix('[') {
        rest.split(']').next().unwrap_or("")
    } else {
        host.rsplit_once(':').map_or(host, |(name, _)| name)
    };
    // Parse as an address rather than matching a prefix: "127.example.com" is a hostname an
    // attacker could point at 127.0.0.1.
    name.eq_ignore_ascii_case("localhost") || name.parse::<std::net::IpAddr>().is_ok_and(|ip| ip.is_loopback())
}

pub async fn run(python: &str, request: CodeRequest) -> Result<CodeResponse, String> {
    if request.code.len() > MAX_CODE_BYTES {
        return Err("the code is too long".into());
    }
    let function = request.kind.function();
    let input = serde_json::to_vec(&request).map_err(|e| e.to_string())?;

    let started = Instant::now();
    let mut child = Command::new(python)
        .arg("-c")
        .arg(RUNNER)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("failed to run {python}: {e}"))?;
    let mut stdin = child.stdin.take().expect("stdin is piped");
    stdin.write_all(&input).await.map_err(|e| e.to_string())?;
    drop(stdin);

    let output = tokio::time::timeout(TIMEOUT, child.wait_with_output())
        .await
        .map_err(|_| format!("{function} did not finish within {} s", TIMEOUT.as_secs()))?
        .map_err(|e| e.to_string())?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut response: CodeResponse = stdout
        .lines()
        .rev()
        .find_map(|line| serde_json::from_str(line).ok())
        .ok_or_else(|| {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let tail: Vec<&str> = stderr.lines().rev().take(8).collect();
            format!(
                "the Python runner produced no result:\n{}",
                tail.into_iter().rev().collect::<Vec<_>>().join("\n")
            )
        })?;
    response.elapsed_s = started.elapsed().as_secs_f64();
    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::is_loopback_host;

    #[test]
    fn loopback_hosts() {
        for host in ["localhost", "localhost:8080", "LOCALHOST:1", "127.0.0.1", "127.0.0.1:8080", "127.1.2.3:80", "[::1]", "[::1]:8080"] {
            assert!(is_loopback_host(host), "{host} should be loopback");
        }
        for host in ["", "example.com", "127.evil.example", "127.0.0.1.evil.example:8080", "192.168.1.5:8080", "[::2]:80", "localhost.evil.example"] {
            assert!(!is_loopback_host(host), "{host} should not be loopback");
        }
    }
}
