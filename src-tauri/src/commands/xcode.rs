//! Xcode Command Line Tools detection, install trigger, and background polling.
//!
//! `xcode_clt_status` — returns the current install state (not async).
//! `xcode_clt_install` — spawns `xcode-select --install`, transitions state to
//!   Installing, and starts a background poller that emits `xcode:progress`
//!   events until the CLT directory appears or a 15-minute timeout fires.

use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use uuid::Uuid;

// ─────────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────────

/// Installation state of the Xcode Command Line Tools.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum XcodeCltState {
    NotInstalled,
    Installing,
    Installed,
}

/// Progress event payload emitted on `xcode:progress`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct XcodeProgress {
    /// Unique install handle (UUID).
    pub handle: String,
    /// Human-readable status line.
    pub line: String,
    /// True on the final event for this handle.
    pub finished: bool,
    /// Non-None when the operation ended in an error.
    pub error: Option<String>,
}

// ─────────────────────────────────────────────────────────────────────────────
// Global state
// ─────────────────────────────────────────────────────────────────────────────

/// Internal state tracked across the install lifecycle.
#[derive(Debug, Clone)]
struct XcodeCltInternalState {
    /// Current lifecycle phase.
    phase: XcodeCltState,
    /// Active install handle, if Installing.
    handle: Option<String>,
}

impl Default for XcodeCltInternalState {
    fn default() -> Self {
        Self {
            phase: XcodeCltState::NotInstalled,
            handle: None,
        }
    }
}

static XCODE_STATE: std::sync::OnceLock<Arc<Mutex<XcodeCltInternalState>>> =
    std::sync::OnceLock::new();

fn xcode_state() -> &'static Arc<Mutex<XcodeCltInternalState>> {
    XCODE_STATE.get_or_init(|| Arc::new(Mutex::new(XcodeCltInternalState::default())))
}

// ─────────────────────────────────────────────────────────────────────────────
// State helpers (public so integration tests can drive them)
// ─────────────────────────────────────────────────────────────────────────────

/// Reset global state to `NotInstalled` with no handle.
/// Used by tests to avoid cross-test state pollution.
pub fn reset_xcode_state() {
    let mut s = xcode_state().lock().unwrap();
    s.phase = XcodeCltState::NotInstalled;
    s.handle = None;
}

/// Force global state to `Installing` with a given handle.
/// Exposed for integration tests.
pub fn set_xcode_state_installing(handle: String) {
    let mut s = xcode_state().lock().unwrap();
    s.phase = XcodeCltState::Installing;
    s.handle = Some(handle);
}

fn set_xcode_state_installed() {
    let mut s = xcode_state().lock().unwrap();
    s.phase = XcodeCltState::Installed;
    s.handle = None;
}

fn set_xcode_state_not_installed() {
    let mut s = xcode_state().lock().unwrap();
    s.phase = XcodeCltState::NotInstalled;
    s.handle = None;
}

fn current_phase() -> XcodeCltState {
    xcode_state().lock().unwrap().phase.clone()
}

// ─────────────────────────────────────────────────────────────────────────────
// Default CLT path
// ─────────────────────────────────────────────────────────────────────────────

fn default_clt_dir() -> PathBuf {
    PathBuf::from("/Library/Developer/CommandLineTools")
}

// ─────────────────────────────────────────────────────────────────────────────
// Status impl (pure, no AppHandle — testable without a Tauri runtime)
// ─────────────────────────────────────────────────────────────────────────────

/// Core status logic.  Checks global phase first (Installing wins), then
/// probes the filesystem.  `clt_dir` is injectable for tests.
pub fn xcode_clt_status_impl(clt_dir: &Path) -> XcodeCltState {
    // Global phase takes precedence.
    match current_phase() {
        XcodeCltState::Installing => return XcodeCltState::Installing,
        XcodeCltState::Installed => return XcodeCltState::Installed,
        XcodeCltState::NotInstalled => {} // fall through to filesystem check
    }

    if clt_dir.is_dir() {
        XcodeCltState::Installed
    } else {
        XcodeCltState::NotInstalled
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tauri command: xcode_clt_status
// ─────────────────────────────────────────────────────────────────────────────

/// Return the current Xcode CLT install state.
///
/// `clt_dir` overrides `/Library/Developer/CommandLineTools` — pass `None`
/// in production, pass a temp-dir path in tests.
#[tauri::command]
pub fn xcode_clt_status(clt_dir: Option<String>) -> XcodeCltState {
    let dir = clt_dir
        .as_deref()
        .map(PathBuf::from)
        .unwrap_or_else(default_clt_dir);
    xcode_clt_status_impl(&dir)
}

// ─────────────────────────────────────────────────────────────────────────────
// Polling impl (async, injectable — returns Result for tests)
// ─────────────────────────────────────────────────────────────────────────────

/// Poll `clt_dir` every `poll_interval_ms` milliseconds until it exists or
/// `timeout_secs` elapses.
///
/// On success, transitions global state to Installed and returns
/// `Ok(XcodeCltState::Installed)`.
///
/// On timeout, transitions global state back to NotInstalled and returns
/// `Err("Xcode CLT installation timed out after N seconds")`.
///
/// `app` is `Option<AppHandle>` so tests can omit it without needing a Tauri
/// runtime.
pub async fn xcode_clt_poll_impl(
    clt_dir: PathBuf,
    _handle: String,
    timeout_secs: u64,
    poll_interval_ms: u64,
) -> Result<XcodeCltState, String> {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(timeout_secs);
    let interval = std::time::Duration::from_millis(poll_interval_ms);

    loop {
        if clt_dir.is_dir() {
            set_xcode_state_installed();
            return Ok(XcodeCltState::Installed);
        }

        if std::time::Instant::now() >= deadline {
            set_xcode_state_not_installed();
            return Err(format!(
                "Xcode CLT installation timed out after {} seconds",
                timeout_secs
            ));
        }

        tokio::time::sleep(interval).await;
    }
}

/// Best-effort tail of /var/log/install.log for real CLT install progress.
///
/// Returns `(lines_emitted, new_position)` so the caller can track how many
/// matching lines were surfaced since the last call — used to decide whether
/// a generic heartbeat is still needed. The file is world-readable on macOS
/// so this works without elevated permissions. If the file is absent or a
/// read fails we just report zero — the poller keeps running.
fn drain_install_log(
    path: &Path,
    position: &mut u64,
    app: &AppHandle,
    handle: &str,
) -> u64 {
    let Ok(mut file) = std::fs::File::open(path) else {
        return 0;
    };
    // Clamp position to file length — install.log gets rotated; if we're
    // past the end after a rotation, start from 0.
    let len = file.metadata().map(|m| m.len()).unwrap_or(0);
    if *position > len {
        *position = 0;
    }
    if file.seek(SeekFrom::Start(*position)).is_err() {
        return 0;
    }
    let mut buf = String::new();
    let _ = file.read_to_string(&mut buf);
    *position += buf.len() as u64;

    let mut emitted = 0u64;
    for line in buf.lines() {
        // Only forward lines that look like CLT install activity.
        if !line.contains("CLTools") && !line.contains("Command Line Tools") {
            continue;
        }
        // install.log lines are "<timestamp> <host> <proc>: <msg>" — the
        // user doesn't need the preamble, just the message.
        let msg = line
            .splitn(4, ' ')
            .nth(3)
            .map(str::trim)
            .unwrap_or(line)
            .to_string();
        let _ = app.emit(
            "xcode:progress",
            XcodeProgress {
                handle: handle.to_string(),
                line: msg,
                finished: false,
                error: None,
            },
        );
        emitted += 1;
    }
    emitted
}

/// Sentinel file Apple's installer creates when the CLT install dialog is
/// accepted. Presence ⇒ install was authorized and packages are being
/// written. Absence after a grace period ⇒ the dialog was dismissed or
/// never appeared (hidden behind other windows, etc.).
const CLT_IN_PROGRESS_MARKER: &str = "/tmp/.com.apple.dt.CommandLineTools.installondemand.in-progress";

/// Same as `xcode_clt_poll_impl` but also emits Tauri progress events.
///
/// Emission strategy:
///   1. Poll `clt_dir` every `poll_interval_ms` — when it appears, install
///      is complete.
///   2. Tail `/var/log/install.log` on every tick, forwarding any
///      `CLTools` / `Command Line Tools` lines as real progress events.
///   3. If no real log progress landed for `HEARTBEAT_SECS` seconds, emit a
///      generic elapsed-time heartbeat so the user knows we're still alive.
///   4. Check the `/tmp/…installondemand.in-progress` sentinel at
///      `AUTH_GRACE_SECS` — if it never appeared, the dialog was dismissed
///      or hidden, so prompt the user to retry.
async fn xcode_clt_poll_with_events(
    app: AppHandle,
    clt_dir: PathBuf,
    handle: String,
    timeout_secs: u64,
    poll_interval_ms: u64,
) {
    let start = std::time::Instant::now();
    let deadline = start + std::time::Duration::from_secs(timeout_secs);
    let interval = std::time::Duration::from_millis(poll_interval_ms);
    // Emit a generic heartbeat only if no real-progress line has landed in
    // this many seconds.
    const HEARTBEAT_SECS: u64 = 20;
    // Check the installondemand sentinel file after this much time — if
    // still absent, the install dialog was never accepted.
    const AUTH_GRACE_SECS: u64 = 25;
    // Fallback "dialog may have been dismissed" hint for the case where the
    // sentinel check is inconclusive (e.g. permission denied on /tmp check).
    const DISMISS_HINT_SECS: u64 = 90;

    // Initial line — always shown once.
    let _ = app.emit(
        "xcode:progress",
        XcodeProgress {
            handle: handle.clone(),
            line: "Waiting for the Xcode Command Line Tools installer to finish…".to_string(),
            finished: false,
            error: None,
        },
    );

    let install_log = PathBuf::from("/var/log/install.log");
    // Start at end-of-file so we don't replay old install.log history.
    let mut log_position: u64 = std::fs::metadata(&install_log)
        .map(|m| m.len())
        .unwrap_or(0);

    let mut last_real_progress = start;
    let mut last_heartbeat = start;
    let mut auth_checked = false;
    let mut dismiss_hint_sent = false;

    loop {
        if clt_dir.is_dir() {
            set_xcode_state_installed();
            let _ = app.emit(
                "xcode:progress",
                XcodeProgress {
                    handle: handle.clone(),
                    line: "Xcode Command Line Tools installed successfully.".to_string(),
                    finished: true,
                    error: None,
                },
            );
            return;
        }

        if std::time::Instant::now() >= deadline {
            set_xcode_state_not_installed();
            let _ = app.emit(
                "xcode:progress",
                XcodeProgress {
                    handle: handle.clone(),
                    line: String::new(),
                    finished: true,
                    error: Some(format!(
                        "Xcode CLT installation timed out after {} seconds. If the system dialog never appeared, close and retry; otherwise install manually from https://developer.apple.com/download/all/",
                        timeout_secs
                    )),
                },
            );
            return;
        }

        // Pull real progress from Apple's install log.
        let emitted = drain_install_log(&install_log, &mut log_position, &app, &handle);
        if emitted > 0 {
            last_real_progress = std::time::Instant::now();
            last_heartbeat = std::time::Instant::now();
        }

        let elapsed = start.elapsed();
        let elapsed_secs = elapsed.as_secs();

        // Auth check: after AUTH_GRACE_SECS, look for the installondemand
        // sentinel. If absent AND no real log progress seen, the dialog was
        // dismissed / never accepted.
        if !auth_checked && elapsed_secs >= AUTH_GRACE_SECS {
            auth_checked = true;
            let marker_present = Path::new(CLT_IN_PROGRESS_MARKER).exists();
            let saw_real_progress = last_real_progress > start;
            if !marker_present && !saw_real_progress {
                let _ = app.emit(
                    "xcode:progress",
                    XcodeProgress {
                        handle: handle.clone(),
                        line: "No install activity detected. The system dialog may be hidden behind another window, or it was dismissed. Check for a dialog titled \"Install Command Line Developer Tools\" — or click Retry to re-trigger it.".to_string(),
                        finished: false,
                        error: None,
                    },
                );
                last_heartbeat = std::time::Instant::now();
            }
        }

        // Generic heartbeat only if nothing real has happened recently.
        if last_real_progress.elapsed().as_secs() >= HEARTBEAT_SECS
            && last_heartbeat.elapsed().as_secs() >= HEARTBEAT_SECS
        {
            last_heartbeat = std::time::Instant::now();
            let _ = app.emit(
                "xcode:progress",
                XcodeProgress {
                    handle: handle.clone(),
                    line: format!(
                        "Still installing… ({}m{:02}s elapsed)",
                        elapsed_secs / 60,
                        elapsed_secs % 60
                    ),
                    finished: false,
                    error: None,
                },
            );
        }

        // Fallback hint at DISMISS_HINT_SECS if the auth check was silent.
        if !dismiss_hint_sent
            && elapsed_secs >= DISMISS_HINT_SECS
            && last_real_progress == start
        {
            dismiss_hint_sent = true;
            let _ = app.emit(
                "xcode:progress",
                XcodeProgress {
                    handle: handle.clone(),
                    line: "Still no install activity. Click Retry to re-trigger the system dialog, or install Xcode Command Line Tools manually via the App Store.".to_string(),
                    finished: false,
                    error: None,
                },
            );
        }

        tokio::time::sleep(interval).await;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tauri command: xcode_clt_install
// ─────────────────────────────────────────────────────────────────────────────

/// Core install logic, injectable for tests.
///
/// `clt_dir`     — the CLT directory to watch (tests pass a TempDir path).
/// `skip_spawn`  — when `true`, skips the real `xcode-select --install`
///                 invocation.  Always `false` in production.
pub async fn xcode_clt_install_impl(
    app: AppHandle,
    clt_dir: PathBuf,
    skip_spawn: bool,
) -> Result<String, String> {
    // Idempotency guards.
    match current_phase() {
        XcodeCltState::Installed => {
            return Err("Xcode Command Line Tools are already installed.".to_string());
        }
        XcodeCltState::Installing => {
            return Err("Xcode Command Line Tools installation is already in progress.".to_string());
        }
        XcodeCltState::NotInstalled => {}
    }

    let handle_id = Uuid::new_v4().to_string();

    if !skip_spawn {
        Command::new("xcode-select")
            .arg("--install")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("Failed to spawn xcode-select: {}", e))?;
    }

    set_xcode_state_installing(handle_id.clone());

    // Emit initial event.
    let _ = app.emit(
        "xcode:progress",
        XcodeProgress {
            handle: handle_id.clone(),
            line: "Xcode Command Line Tools installation started. Follow the system dialog.".to_string(),
            finished: false,
            error: None,
        },
    );

    // Background poller: 15-minute production timeout, 2-second poll interval.
    let app_clone = app.clone();
    let dir_clone = clt_dir.clone();
    let handle_clone = handle_id.clone();

    tokio::spawn(async move {
        xcode_clt_poll_with_events(
            app_clone,
            dir_clone,
            handle_clone,
            900, // 15 minutes
            2_000,
        )
        .await;
    });

    Ok(handle_id)
}

/// Trigger the Xcode CLT install dialog and start background polling.
///
/// Returns the install handle so the frontend can correlate `xcode:progress`
/// events.
#[tauri::command]
pub async fn xcode_clt_install(app: AppHandle) -> Result<String, String> {
    xcode_clt_install_impl(app, default_clt_dir(), false).await
}
