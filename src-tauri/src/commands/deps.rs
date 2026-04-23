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

/// One-shot cache for the user's login-shell PATH. See `shell_login_path`.
static SHELL_LOGIN_PATH: std::sync::OnceLock<String> = std::sync::OnceLock::new();

/// Capture the user's login-shell `$PATH` once per process.
///
/// A GUI-launched Tauri app on macOS inherits only `/usr/bin:/bin:/usr/sbin:/sbin`
/// from LaunchServices. Users install CLI tools via all sorts of managers —
/// nvm, fnm, asdf, volta, mise, direnv, manual prefixes — that only wire
/// their bin dirs into `$PATH` via the shell's profile (`.zshrc`, `.zprofile`,
/// `.bash_profile`, etc.). So the only portable way to find `qmd`, `claude`,
/// `hq-sync-runner` etc. is to invoke the login shell and read what PATH it
/// assembles.
///
/// Cached with `OnceLock` — the subprocess spawn is ~100 ms the first time
/// and free on subsequent calls within the app lifetime.
fn shell_login_path() -> &'static str {
    SHELL_LOGIN_PATH.get_or_init(|| {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into());
        let output = Command::new(&shell)
            .args(["-lc", "printf %s \"$PATH\""])
            .stdin(Stdio::null())
            .output();
        match output {
            Ok(out) if out.status.success() => String::from_utf8(out.stdout)
                .unwrap_or_default()
                .trim()
                .to_string(),
            _ => String::new(),
        }
    })
}

/// Build a PATH string that includes macOS install prefixes a GUI-launched
/// app does NOT inherit from the user's shell (brew, user-local installs,
/// Claude Code, qmd). Without this, `which brew` fails even though the
/// user has Homebrew installed, because LaunchServices-launched apps only
/// get `/usr/bin:/bin:/usr/sbin:/sbin`.
pub fn extended_search_path() -> String {
    extended_search_path_in(None)
}

/// Same composition as `extended_search_path()` but accepts an explicit
/// home-directory override so tests can exercise version-manager discovery
/// against a fixture directory without mutating process-global HOME.
///
/// When `home` is `None`, resolves via `dirs::home_dir()` (production path).
pub fn extended_search_path_in(home: Option<&std::path::Path>) -> String {
    let mut dirs: Vec<String> = Vec::new();
    if let Ok(existing) = std::env::var("PATH") {
        if !existing.is_empty() {
            dirs.push(existing);
        }
    }
    // Seed from the user's login shell — picks up nvm/fnm/asdf/volta/mise etc.
    // that inject node-version-manager bin dirs via profile scripts. This is
    // the only reliable way to find tools installed via `npm i -g` on systems
    // where the global prefix is under ~/.nvm/versions/node/<v>/bin or similar.
    let shell_path = shell_login_path();
    if !shell_path.is_empty() {
        dirs.push(shell_path.to_string());
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
    // Resolve home directory: explicit override for tests, else dirs::home_dir().
    let home_buf = home.map(|p| p.to_path_buf()).or_else(dirs::home_dir);

    // User-local installs (~/.claude/bin, ~/.cargo/bin, ~/.local/bin, ~/bin).
    if let Some(home) = home_buf.as_deref() {
        for rel in [".claude/bin", ".cargo/bin", ".local/bin", "bin"] {
            let p = home.join(rel);
            dirs.push(p.to_string_lossy().into_owned());
        }
    }
    // Node version managers — enumerate installed Node versions so CLIs
    // installed via `npm i -g` under nvm/fnm (plus volta and pnpm's global
    // bin) are detected even when the shell-login PATH probe returns empty
    // (GUI launch without inherited SHELL). Each block tolerates missing
    // dirs and read_dir errors silently; a failed probe never blocks other
    // managers from being tried.
    if let Some(home) = home_buf.as_deref() {
        for d in version_manager_dirs(home) {
            dirs.push(d);
        }
    }
    dirs.join(":")
}

/// Collect bin directories from Node version managers present under `home`.
///
/// Covers: nvm (~/.nvm/versions/node/<v>/bin), fnm
/// (~/.fnm/node-versions/<v>/installation/bin), volta (~/.volta/bin),
/// pnpm (~/Library/pnpm — macOS location).
///
/// Missing dirs, permission errors, and stale version entries without a
/// `/bin` subdir are silently skipped. This function never panics.
fn version_manager_dirs(home: &std::path::Path) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();

    // nvm: enumerate ~/.nvm/versions/node/*/bin
    // read_dir order is filesystem-defined (unspecified). We sort descending by
    // parsed version tuple so which::which_in resolves to the newest toolchain
    // first — otherwise install_claude_code / install_qmd could target an older
    // global prefix on multi-version systems.
    let nvm_root = home.join(".nvm").join("versions").join("node");
    if let Ok(entries) = std::fs::read_dir(&nvm_root) {
        let mut collected: Vec<((u32, u32, u32), String)> = Vec::new();
        for entry in entries.flatten() {
            let p = entry.path();
            if p.is_dir() {
                let bin = p.join("bin");
                if bin.exists() {
                    let name = entry.file_name();
                    let version = parse_node_version(&name.to_string_lossy());
                    collected.push((version, bin.to_string_lossy().into_owned()));
                }
            }
        }
        collected.sort_by(|a, b| b.0.cmp(&a.0));
        for (_, path) in collected {
            out.push(path);
        }
    }

    // fnm: enumerate ~/.fnm/node-versions/*/installation/bin
    // Same descending-version sort as the nvm block above.
    let fnm_root = home.join(".fnm").join("node-versions");
    if let Ok(entries) = std::fs::read_dir(&fnm_root) {
        let mut collected: Vec<((u32, u32, u32), String)> = Vec::new();
        for entry in entries.flatten() {
            let p = entry.path();
            if p.is_dir() {
                let bin = p.join("installation").join("bin");
                if bin.exists() {
                    let name = entry.file_name();
                    let version = parse_node_version(&name.to_string_lossy());
                    collected.push((version, bin.to_string_lossy().into_owned()));
                }
            }
        }
        collected.sort_by(|a, b| b.0.cmp(&a.0));
        for (_, path) in collected {
            out.push(path);
        }
    }

    // volta: single dir ~/.volta/bin
    let volta_bin = home.join(".volta").join("bin");
    if volta_bin.is_dir() {
        out.push(volta_bin.to_string_lossy().into_owned());
    }

    // pnpm global bin on macOS: ~/Library/pnpm
    let pnpm_bin = home.join("Library").join("pnpm");
    if pnpm_bin.is_dir() {
        out.push(pnpm_bin.to_string_lossy().into_owned());
    }

    out
}

/// Parse a Node version directory name like `v22.17.0` or `20.10.1` into a
/// `(major, minor, patch)` tuple for ordering. Strips a leading `v`, splits
/// on `.`, and takes the first 3 components. Any unparseable component (or
/// missing component) becomes `0` so malformed names sort last. Never panics.
fn parse_node_version(dir_name: &str) -> (u32, u32, u32) {
    let trimmed = dir_name.strip_prefix('v').unwrap_or(dir_name);
    let mut parts = trimmed.split('.');
    let major = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
    let minor = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
    let patch = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
    (major, minor, patch)
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
/// Both stdout and stderr are drained concurrently:
///   - stdout lines are forwarded verbatim as progress events.
///   - stderr lines are forwarded as progress events AND retained so the
///     final error message carries actual context. Many installers (npm,
///     brew) write EACCES / registry / post-install-script failures to
///     stderr, not stdout — without draining stderr the installer just
///     said "exit code 1" and the user was stuck.
///   - Draining stderr in a thread also prevents the child from blocking
///     on a full stderr pipe (macOS default pipe buffer is 32 KB).
///
/// The spawned child inherits `PATH = extended_search_path()` so that any
/// sub-tools invoked by the installer (npm post-install scripts reaching
/// for `node`, `git`, `python3`, etc.) can be resolved from the full set
/// of macOS locations a GUI-launched Tauri app does NOT inherit.
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
        .env("PATH", extended_search_path())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to spawn '{}': {}", program, e))?;

    let stdout = child.stdout.take().ok_or("no stdout")?;
    let stderr = child.stderr.take().ok_or("no stderr")?;

    // Drain stderr in a background thread — see the function doc above for why.
    let stderr_lines: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let stderr_thread = {
        let app = app.clone();
        let handle_id = handle_id.clone();
        let stderr_lines = Arc::clone(&stderr_lines);
        std::thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line_result in reader.lines() {
                let Ok(line) = line_result else { break };
                stderr_lines.lock().unwrap().push(line.clone());
                let _ = app.emit(
                    "install:progress",
                    InstallProgress {
                        handle: handle_id.clone(),
                        line,
                        finished: false,
                        error: None,
                    },
                );
            }
        })
    };

    let reader = BufReader::new(stdout);

    for line_result in reader.lines() {
        // Honour cancel.
        if is_cancelled(&handle_id) {
            let _ = child.kill();
            let _ = stderr_thread.join();
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
    let _ = stderr_thread.join();
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
        let captured = stderr_lines.lock().unwrap().clone();
        let msg = format_install_error(code, &captured);
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

/// Emit a single progress line to the frontend before a preflight check
/// rejects the install.
///
/// The DepsInstall screen routes `install:progress` lines into the active
/// tool's terminal panel by `activeToolRef`, not by handle — so emitting here
/// surfaces useful context in the UI even though no real process ever ran.
/// Without this, `install_node` / `install_gh` return a bare `Err(…)` and
/// the panel is empty: the user sees "Installation failed" with no clue why.
fn emit_preflight_line(app: &AppHandle, msg: &str) {
    let _ = app.emit(
        "install:progress",
        InstallProgress {
            handle: "preflight".to_string(),
            line: msg.to_string(),
            finished: false,
            error: None,
        },
    );
}

/// Format a human-friendly error message from an exit code plus the stderr
/// lines captured by `run_streaming`. Keeps the last few non-empty lines so
/// the UI stays readable when tools dump multi-KB of output.
///
/// Exposed for unit tests; no Tauri runtime needed.
pub fn format_install_error(exit_code: i32, stderr_lines: &[String]) -> String {
    let mut tail: Vec<String> = stderr_lines
        .iter()
        .rev()
        .filter(|l| !l.trim().is_empty())
        .take(5)
        .cloned()
        .collect();
    tail.reverse();
    if tail.is_empty() {
        format!("Process exited with code {}", exit_code)
    } else {
        format!(
            "Process exited with code {}: {}",
            exit_code,
            tail.join(" | ")
        )
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// install_homebrew
// ─────────────────────────────────────────────────────────────────────────────

/// Install Homebrew using the official curl-pipe-bash installer.
///
/// The canonical Homebrew install command is:
///   `/bin/bash -c "$(curl -fsSL https://.../install.sh)"`
///
/// That relies on a *parent* shell to evaluate `$(curl …)` before invoking
/// `/bin/bash -c`. When we spawn `/bin/bash -c …` directly from Rust there
/// is no parent shell: the substitution happens inside bash itself, but the
/// resulting script text is then a bare quoted-string expression — not a
/// command — and bash tries to exec the first word (`#!/bin/bash`), producing
/// "No such file or directory".
///
/// The nested form below restores the two-shell semantics: the *outer* bash
/// evaluates `"$(curl …)"` and hands the expanded script to the *inner*
/// `bash -c` for execution. `NONINTERACTIVE=1` is set so the installer
/// skips the "press RETURN to continue" prompt that would otherwise hang
/// silently in our Stdio::piped setup.
///
/// Returns the install handle so the frontend can correlate progress events.
#[tauri::command]
pub async fn install_homebrew(app: AppHandle) -> Result<String, String> {
    run_streaming(
        &app,
        "/bin/bash",
        &[
            "-c",
            r#"NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)""#,
        ],
    )
    .await
}

// ─────────────────────────────────────────────────────────────────────────────
// install_node
// ─────────────────────────────────────────────────────────────────────────────

/// Install Node.js via `brew install node`.
///
/// Errors if Homebrew is not available — surfaces the reason in the terminal
/// panel via `emit_preflight_line` before returning.
#[tauri::command]
pub async fn install_node(app: AppHandle) -> Result<String, String> {
    let brew = match which::which_in(
        "brew",
        Some(extended_search_path()),
        std::env::current_dir().unwrap_or_default(),
    ) {
        Ok(p) => p,
        Err(_) => {
            let msg = "Homebrew is not installed. Install Homebrew first.";
            emit_preflight_line(&app, msg);
            return Err(msg.to_string());
        }
    };
    run_streaming(&app, brew.to_str().unwrap_or("brew"), &["install", "node"]).await
}

// ─────────────────────────────────────────────────────────────────────────────
// install_git
// ─────────────────────────────────────────────────────────────────────────────

/// Install git via `brew install git`.
#[tauri::command]
pub async fn install_git(app: AppHandle) -> Result<String, String> {
    let brew = match which::which_in(
        "brew",
        Some(extended_search_path()),
        std::env::current_dir().unwrap_or_default(),
    ) {
        Ok(p) => p,
        Err(_) => {
            let msg = "Homebrew is not installed. Install Homebrew first.";
            emit_preflight_line(&app, msg);
            return Err(msg.to_string());
        }
    };
    run_streaming(&app, brew.to_str().unwrap_or("brew"), &["install", "git"]).await
}

// ─────────────────────────────────────────────────────────────────────────────
// install_gh
// ─────────────────────────────────────────────────────────────────────────────

/// Install the GitHub CLI via `brew install gh`.
#[tauri::command]
pub async fn install_gh(app: AppHandle) -> Result<String, String> {
    let brew = match which::which_in(
        "brew",
        Some(extended_search_path()),
        std::env::current_dir().unwrap_or_default(),
    ) {
        Ok(p) => p,
        Err(_) => {
            let msg = "Homebrew is not installed. Install Homebrew first.";
            emit_preflight_line(&app, msg);
            return Err(msg.to_string());
        }
    };
    run_streaming(&app, brew.to_str().unwrap_or("brew"), &["install", "gh"]).await
}

// ─────────────────────────────────────────────────────────────────────────────
// install_yq
// ─────────────────────────────────────────────────────────────────────────────

/// Install yq via `brew install yq`.
///
/// Required by the Workspace integrity scripts (compute-checksums.sh,
/// core-integrity.sh) that read/write scripts/core.yaml.
#[tauri::command]
pub async fn install_yq(app: AppHandle) -> Result<String, String> {
    let brew = match which::which_in(
        "brew",
        Some(extended_search_path()),
        std::env::current_dir().unwrap_or_default(),
    ) {
        Ok(p) => p,
        Err(_) => {
            let msg = "Homebrew is not installed. Install Homebrew first.";
            emit_preflight_line(&app, msg);
            return Err(msg.to_string());
        }
    };
    run_streaming(&app, brew.to_str().unwrap_or("brew"), &["install", "yq"]).await
}

// ─────────────────────────────────────────────────────────────────────────────
// install_claude_code
// ─────────────────────────────────────────────────────────────────────────────

/// Install the Claude Code CLI via `npm install -g @anthropic-ai/claude-code`.
///
/// Errors if npm is not available.
#[tauri::command]
pub async fn install_claude_code(app: AppHandle) -> Result<String, String> {
    let npm = match which::which_in(
        "npm",
        Some(extended_search_path()),
        std::env::current_dir().unwrap_or_default(),
    ) {
        Ok(p) => p,
        Err(_) => {
            let msg = "npm is not installed. Install Node.js first.";
            emit_preflight_line(&app, msg);
            return Err(msg.to_string());
        }
    };
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
    let npm = match which::which_in(
        "npm",
        Some(extended_search_path()),
        std::env::current_dir().unwrap_or_default(),
    ) {
        Ok(p) => p,
        Err(_) => {
            let msg = "npm is not installed. Install Node.js first.";
            emit_preflight_line(&app, msg);
            return Err(msg.to_string());
        }
    };
    run_streaming(
        &app,
        npm.to_str().unwrap_or("npm"),
        &["install", "-g", "@tobilu/qmd"],
    )
    .await
}

// NOTE (2026-04-21): `install_hq_cloud` was removed along with the
// `hq-cloud` DEPS row in 04-deps.tsx. The HQ Sync menubar app now spawns
// the runner via `npx -y --package=@indigoai-us/hq-cloud@<ver>
// hq-sync-runner …` (see hq-sync/src-tauri/src/commands/sync.rs), which
// removes the need for a global install. Do NOT re-add this command
// unless you're also re-adding a frontend invocation — the previous
// backend-only re-add stranded a dead Tauri handler.
