//! Dependency probe and install commands for the HQ installer.
//!
//! All install commands are macOS / Homebrew-centric.  Each installer
//! streams stdout lines to the frontend via `install:progress` events and
//! supports cancellation through a shared handle registry.

use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use uuid::Uuid;

// ─────────────────────────────────────────────────────────────────────────────
// Cancel registry
// ─────────────────────────────────────────────────────────────────────────────

/// Global map from install-handle → cancelled flag.
static CANCEL_REGISTRY: std::sync::OnceLock<Arc<Mutex<HashMap<String, bool>>>> =
    std::sync::OnceLock::new();

fn cancel_registry() -> &'static Arc<Mutex<HashMap<String, bool>>> {
    CANCEL_REGISTRY.get_or_init(|| Arc::new(Mutex::new(HashMap::new())))
}

/// Register a new cancel handle (called at the start of every install).
/// Exposed publicly so the test suite can exercise `cancel_install` without
/// spawning a real Tauri runtime.
pub fn register_cancel_handle(handle: String) {
    cancel_registry()
        .lock()
        .unwrap()
        .insert(handle, false);
}

fn is_cancelled(handle: &str) -> bool {
    cancel_registry()
        .lock()
        .unwrap()
        .get(handle)
        .copied()
        .unwrap_or(false)
}

fn deregister_handle(handle: &str) {
    cancel_registry().lock().unwrap().remove(handle);
}

// ─────────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────────

/// Result returned by `check_dep`.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct DepStatus {
    pub installed: bool,
    pub version: Option<String>,
    pub path: Option<PathBuf>,
}

/// Progress event payload emitted on `install:progress`.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct InstallProgress {
    /// Unique install handle.
    pub handle: String,
    /// A single line of stdout from the install process.
    pub line: String,
    /// True on the final event for this handle.
    pub finished: bool,
    /// Non-None when the install ended in an error.
    pub error: Option<String>,
}

// ─────────────────────────────────────────────────────────────────────────────
// check_dep
// ─────────────────────────────────────────────────────────────────────────────

/// Build a PATH string that includes macOS install prefixes a GUI-launched
/// app does NOT inherit from the user's shell (brew, user-local installs,
/// Claude Code, qmd). Without this, `which brew` fails even though the
/// user has Homebrew installed, because LaunchServices-launched apps only
/// get `/usr/bin:/bin:/usr/sbin:/sbin`.
fn extended_search_path() -> String {
    let mut dirs: Vec<String> = Vec::new();
    if let Ok(existing) = std::env::var("PATH") {
        if !existing.is_empty() {
            dirs.push(existing);
        }
    }
    // Standard macOS install locations that GUI app PATH misses.
    let extras = [
        "/opt/homebrew/bin",  // Apple Silicon Homebrew
        "/opt/homebrew/sbin",
        "/usr/local/bin", // Intel Homebrew + generic
        "/usr/local/sbin",
    ];
    for e in extras {
        dirs.push(e.to_string());
    }
    // User-local installs (~/.claude/bin, ~/.cargo/bin, ~/.local/bin, ~/bin).
    if let Some(home) = dirs::home_dir() {
        for rel in [".claude/bin", ".cargo/bin", ".local/bin", "bin"] {
            let p = home.join(rel);
            dirs.push(p.to_string_lossy().into_owned());
        }
    }
    dirs.join(":")
}

/// Internal implementation shared by `check_dep` (uses real PATH) and
/// `check_dep_in` (uses a caller-supplied search path — useful for tests).
pub fn check_dep_impl(tool: &str, search_path: Option<&str>) -> DepStatus {
    // Locate the binary.
    let cwd = std::env::current_dir().unwrap_or_default();
    let bin_path = match search_path {
        Some(p) => which::which_in(tool, Some(p), cwd),
        // GUI apps inherit a minimal PATH — extend with common install dirs.
        None => which::which_in(tool, Some(extended_search_path()), cwd),
    };

    let bin_path = match bin_path {
        Ok(p) => p,
        Err(_) => {
            return DepStatus {
                installed: false,
                version: None,
                path: None,
            }
        }
    };

    // Run `<tool> --version` and capture the first line of stdout.
    let version = Command::new(&bin_path)
        .arg("--version")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .ok()
        .and_then(|out| {
            if out.status.success() || !out.stdout.is_empty() {
                // Prefer stdout; fall back to stderr (e.g. git)
                let raw = if !out.stdout.is_empty() {
                    out.stdout
                } else {
                    out.stderr
                };
                String::from_utf8(raw)
                    .ok()
                    .and_then(|s| s.lines().next().map(|l| l.trim().to_string()))
                    .filter(|s| !s.is_empty())
            } else {
                None
            }
        });

    DepStatus {
        installed: true,
        version,
        path: Some(bin_path),
    }
}

/// Probe whether `tool` is available on PATH.
///
/// Uses `which` to locate the binary then runs `<tool> --version` to capture
/// the version string.  Returns a `DepStatus` that is safe to serialise and
/// send to the frontend.
#[tauri::command]
pub fn check_dep(tool: String) -> DepStatus {
    check_dep_impl(&tool, None)
}

/// Same as `check_dep` but searches only within `path_dirs`.
///
/// Exposed for hermetic unit tests so they don't need to mutate `PATH`.
pub fn check_dep_in(tool: &str, path_dirs: &str) -> DepStatus {
    check_dep_impl(tool, Some(path_dirs))
}

// ─────────────────────────────────────────────────────────────────────────────
// cancel_install
// ─────────────────────────────────────────────────────────────────────────────

/// Set the cancel flag for the given handle.
///
/// Returns `true` if the handle was registered (i.e. an install was in
/// progress), `false` otherwise.
#[tauri::command]
pub fn cancel_install(handle: String) -> bool {
    let mut reg = cancel_registry().lock().unwrap();
    if reg.contains_key(&handle) {
        reg.insert(handle, true);
        true
    } else {
        false
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal streaming helper
// ─────────────────────────────────────────────────────────────────────────────

/// Spawn `program` with `args`, stream stdout line-by-line as
/// `install:progress` events, and respect the cancel flag.
///
/// Returns `Ok(handle)` on success or `Err(message)` on failure.
async fn run_streaming(
    app: &AppHandle,
    program: &str,
    args: &[&str],
) -> Result<String, String> {
    let handle_id = Uuid::new_v4().to_string();
    register_cancel_handle(handle_id.clone());

    let mut child = Command::new(program)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to spawn '{}': {}", program, e))?;

    let stdout = child.stdout.take().ok_or("no stdout")?;
    let reader = BufReader::new(stdout);

    for line_result in reader.lines() {
        // Honour cancel.
        if is_cancelled(&handle_id) {
            let _ = child.kill();
            deregister_handle(&handle_id);
            let _ = app.emit(
                "install:progress",
                InstallProgress {
                    handle: handle_id.clone(),
                    line: String::new(),
                    finished: true,
                    error: Some("Cancelled by user".to_string()),
                },
            );
            return Err("Cancelled".to_string());
        }

        let line = line_result.map_err(|e| e.to_string())?;
        let _ = app.emit(
            "install:progress",
            InstallProgress {
                handle: handle_id.clone(),
                line: line.clone(),
                finished: false,
                error: None,
            },
        );
    }

    let status = child.wait().map_err(|e| e.to_string())?;
    deregister_handle(&handle_id);

    if status.success() {
        let _ = app.emit(
            "install:progress",
            InstallProgress {
                handle: handle_id.clone(),
                line: String::new(),
                finished: true,
                error: None,
            },
        );
        Ok(handle_id)
    } else {
        let code = status.code().unwrap_or(-1);
        let msg = format!("Process exited with code {}", code);
        let _ = app.emit(
            "install:progress",
            InstallProgress {
                handle: handle_id.clone(),
                line: String::new(),
                finished: true,
                error: Some(msg.clone()),
            },
        );
        Err(msg)
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// install_homebrew
// ─────────────────────────────────────────────────────────────────────────────

/// Install Homebrew using the official curl-pipe-bash installer.
///
/// Returns the install handle so the frontend can correlate progress events.
#[tauri::command]
pub async fn install_homebrew(app: AppHandle) -> Result<String, String> {
    run_streaming(
        &app,
        "/bin/bash",
        &[
            "-c",
            r#"$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"#,
        ],
    )
    .await
}

// ─────────────────────────────────────────────────────────────────────────────
// install_node
// ─────────────────────────────────────────────────────────────────────────────

/// Install Node.js via `brew install node`.
///
/// Errors if Homebrew is not available.
#[tauri::command]
pub async fn install_node(app: AppHandle) -> Result<String, String> {
    let brew = which::which_in("brew", Some(extended_search_path()), std::env::current_dir().unwrap_or_default())
        .map_err(|_| "Homebrew is not installed. Install Homebrew first.".to_string())?;
    run_streaming(&app, brew.to_str().unwrap_or("brew"), &["install", "node"]).await
}

// ─────────────────────────────────────────────────────────────────────────────
// install_git
// ─────────────────────────────────────────────────────────────────────────────

/// Install git via `brew install git`.
#[tauri::command]
pub async fn install_git(app: AppHandle) -> Result<String, String> {
    let brew = which::which_in("brew", Some(extended_search_path()), std::env::current_dir().unwrap_or_default())
        .map_err(|_| "Homebrew is not installed. Install Homebrew first.".to_string())?;
    run_streaming(&app, brew.to_str().unwrap_or("brew"), &["install", "git"]).await
}

// ─────────────────────────────────────────────────────────────────────────────
// install_gh
// ─────────────────────────────────────────────────────────────────────────────

/// Install the GitHub CLI via `brew install gh`.
#[tauri::command]
pub async fn install_gh(app: AppHandle) -> Result<String, String> {
    let brew = which::which_in("brew", Some(extended_search_path()), std::env::current_dir().unwrap_or_default())
        .map_err(|_| "Homebrew is not installed. Install Homebrew first.".to_string())?;
    run_streaming(&app, brew.to_str().unwrap_or("brew"), &["install", "gh"]).await
}

// ─────────────────────────────────────────────────────────────────────────────
// install_claude_code
// ─────────────────────────────────────────────────────────────────────────────

/// Install the Claude Code CLI via `npm install -g @anthropic-ai/claude-code`.
///
/// Errors if npm is not available.
#[tauri::command]
pub async fn install_claude_code(app: AppHandle) -> Result<String, String> {
    let npm = which::which_in("npm", Some(extended_search_path()), std::env::current_dir().unwrap_or_default())
        .map_err(|_| "npm is not installed. Install Node.js first.".to_string())?;
    run_streaming(
        &app,
        npm.to_str().unwrap_or("npm"),
        &["install", "-g", "@anthropic-ai/claude-code"],
    )
    .await
}

// ─────────────────────────────────────────────────────────────────────────────
// install_qmd
// ─────────────────────────────────────────────────────────────────────────────

/// Install qmd via `npm install -g @tobilu/qmd`.
///
/// Errors if npm is not available.
#[tauri::command]
pub async fn install_qmd(app: AppHandle) -> Result<String, String> {
    let npm = which::which_in("npm", Some(extended_search_path()), std::env::current_dir().unwrap_or_default())
        .map_err(|_| "npm is not installed. Install Node.js first.".to_string())?;
    run_streaming(
        &app,
        npm.to_str().unwrap_or("npm"),
        &["install", "-g", "@tobilu/qmd"],
    )
    .await
}
