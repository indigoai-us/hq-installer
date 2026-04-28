//! Dependency probe and install commands for the HQ installer.
//!
//! Each installer streams stdout lines to the frontend via `install:progress`
//! events and supports cancellation through a shared handle registry. Required
//! tools use a user-local HQ-managed toolchain when possible; Homebrew remains
//! an optional system package-manager provider.

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
    cancel_registry().lock().unwrap().insert(handle, false);
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
// Diagnostic logging (env-gated)
// ─────────────────────────────────────────────────────────────────────────────

/// Returns `true` when `HQ_INSTALLER_DEBUG_DEPS=1`. Any other value — including
/// `"0"`, `"true"`, empty, or unset — returns `false`. This is the ONLY gate
/// for `[hq-deps]` stderr output; production builds stay silent unless the
/// user explicitly opts in via the env var.
///
/// Exposed publicly so integration tests can verify the gate contract without
/// needing to capture stderr.
pub fn is_deps_debug_enabled() -> bool {
    std::env::var("HQ_INSTALLER_DEBUG_DEPS").ok().as_deref() == Some("1")
}

/// Captures what happened during a `shell_login_path()` probe attempt.
///
/// The enum exists so the pure `format_shell_probe_log` formatter can render
/// each outcome consistently — keeping the `[hq-deps]` log contract in one
/// place and unit-testable without stderr capture.
pub enum ShellProbeOutcome {
    /// Shell exited 0 and returned a non-empty PATH. `bytes` is the length
    /// of the trimmed stdout.
    Success { bytes: usize },
    /// Shell exited with a non-zero status. stderr is not retained so the
    /// log line stays compact; the exit code is usually enough to diagnose.
    NonZeroExit { code: i32 },
    /// Shell exited 0 but returned zero bytes (rare — e.g. `PATH=""` or
    /// profile scripts that erase PATH). Distinct from `Success` so support
    /// docs can call this case out specifically.
    EmptyOutput,
    /// `Command::spawn` failed before the shell ever ran (bad `$SHELL`,
    /// permission denied, etc.). `msg` is the underlying io::Error message.
    SpawnError { msg: String },
}

/// Produce the `[hq-deps]` log line describing a shell-login-path probe.
///
/// Pure formatter — does not emit anything itself. The caller decides whether
/// to `eprintln!` based on `is_deps_debug_enabled()`. Keeping the render pure
/// lets unit tests assert the log format without capturing stderr.
pub fn format_shell_probe_log(shell: &str, outcome: &ShellProbeOutcome) -> String {
    match outcome {
        ShellProbeOutcome::Success { bytes } => format!(
            "[hq-deps] shell_login_path shell={} exit=0 bytes={}",
            shell, bytes
        ),
        ShellProbeOutcome::NonZeroExit { code } => {
            format!("[hq-deps] shell_login_path shell={} exit={}", shell, code)
        }
        ShellProbeOutcome::EmptyOutput => format!(
            "[hq-deps] shell_login_path shell={} exit=0 bytes=0 empty=true",
            shell
        ),
        ShellProbeOutcome::SpawnError { msg } => format!(
            "[hq-deps] shell_login_path shell={} spawn=error msg={}",
            shell, msg
        ),
    }
}

/// Compute per-source directory counts for the PATH log line.
///
/// `shell_path` is the raw colon-joined PATH string returned by
/// `shell_login_path()` — counted by splitting on `:`. The other three
/// are pushed counts tracked by the caller (extras is a static array
/// length; home and vm are incremented as entries are appended).
///
/// Exposed `pub` for hermetic unit testing of the counting logic — no
/// stderr capture needed.
pub fn compute_path_counts(
    shell_path: &str,
    extras_count: usize,
    home_count: usize,
    vm_count: usize,
) -> (usize, usize, usize, usize) {
    let shell_count = if shell_path.is_empty() {
        0
    } else {
        shell_path.split(':').count()
    };
    (shell_count, extras_count, home_count, vm_count)
}

/// Produce the `[hq-deps]` log line describing the final composed PATH.
///
/// `counts` is `(shell, extras, home_local, version_managers)` — the number of
/// directories contributed by each source. The PATH is truncated to 500 chars
/// so copy-pasted support logs stay readable; truncation counts characters
/// (not bytes) to avoid slicing in the middle of a multi-byte UTF-8 codepoint.
pub fn format_path_log(path: &str, counts: (usize, usize, usize, usize)) -> String {
    let truncated: String = path.chars().take(500).collect();
    let (shell, extras, home, vm) = counts;
    format!(
        "[hq-deps] extended_search_path shell={} extras={} home={} vm={} PATH={}",
        shell, extras, home, vm, truncated
    )
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
///
/// Emits a single `[hq-deps]` stderr line when `HQ_INSTALLER_DEBUG_DEPS=1`
/// (via `is_deps_debug_enabled()`); fires at most once per process thanks to
/// the OnceLock cache. Format is treated as a semi-public contract so
/// support paste-backs stay greppable.
fn shell_login_path() -> &'static str {
    SHELL_LOGIN_PATH.get_or_init(|| {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into());
        let spawn_result = Command::new(&shell)
            .args(["-lc", "printf %s \"$PATH\""])
            .stdin(Stdio::null())
            .output();

        let (path, outcome) = match spawn_result {
            Ok(out) if out.status.success() => {
                let s = String::from_utf8(out.stdout)
                    .unwrap_or_default()
                    .trim()
                    .to_string();
                let outcome = if s.is_empty() {
                    ShellProbeOutcome::EmptyOutput
                } else {
                    ShellProbeOutcome::Success { bytes: s.len() }
                };
                (s, outcome)
            }
            Ok(out) => {
                let code = out.status.code().unwrap_or(-1);
                (String::new(), ShellProbeOutcome::NonZeroExit { code })
            }
            Err(e) => (
                String::new(),
                ShellProbeOutcome::SpawnError { msg: e.to_string() },
            ),
        };

        if is_deps_debug_enabled() {
            eprintln!("{}", format_shell_probe_log(&shell, &outcome));
        }
        path
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
    // Prefer the managed HQ toolchain first when it exists. This keeps later
    // qmd/npx runs on the same Node ABI the installer provisioned, even if the
    // user's shell has an older Node earlier in PATH.
    let home_buf = home.map(|p| p.to_path_buf()).or_else(dirs::home_dir);
    let mut home_count: usize = 0;
    if let Some(home) = home_buf.as_deref() {
        for p in managed_tool_paths_in(home) {
            dirs.push(p);
            home_count += 1;
        }
    }
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
        "/opt/homebrew/bin", // Apple Silicon Homebrew
        "/opt/homebrew/sbin",
        "/usr/local/bin", // Intel Homebrew + generic
        "/usr/local/sbin",
    ];
    for e in extras {
        dirs.push(e.to_string());
    }
    // User-local installs (~/.claude/bin, ~/.cargo/bin, ~/.local/bin, ~/bin).
    if let Some(home) = home_buf.as_deref() {
        for rel in [".claude/bin", ".cargo/bin", ".local/bin", "bin"] {
            let p = home.join(rel);
            dirs.push(p.to_string_lossy().into_owned());
            home_count += 1;
        }
    }
    // Node version managers — enumerate installed Node versions so CLIs
    // installed via `npm i -g` under nvm/fnm (plus volta and pnpm's global
    // bin) are detected even when the shell-login PATH probe returns empty
    // (GUI launch without inherited SHELL). Each block tolerates missing
    // dirs and read_dir errors silently; a failed probe never blocks other
    // managers from being tried.
    let mut vm_count: usize = 0;
    if let Some(home) = home_buf.as_deref() {
        for d in version_manager_dirs(home) {
            dirs.push(d);
            vm_count += 1;
        }
    }
    let joined = dirs.join(":");
    // Env-gated diagnostic — emits at most one line per call when
    // HQ_INSTALLER_DEBUG_DEPS=1. Silent for any other value of the env var.
    // shell_path is colon-joined; count individual dirs so support can
    // see how many dirs the login-shell actually contributed.
    if is_deps_debug_enabled() {
        eprintln!(
            "{}",
            format_path_log(
                &joined,
                compute_path_counts(shell_path, extras.len(), home_count, vm_count)
            )
        );
    }
    joined
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
        collected.sort_by_key(|b| std::cmp::Reverse(b.0));
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
        collected.sort_by_key(|b| std::cmp::Reverse(b.0));
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

// ─────────────────────────────────────────────────────────────────────────────
// Managed HQ toolchain
// ─────────────────────────────────────────────────────────────────────────────

/// Pinned Node LTS used for admin-free fresh installs.
///
/// This intentionally moves slower than Node latest. HQ needs a stable Node 22+
/// runtime for npx/qmd/Claude Code, not the newest dist-tag.
const MANAGED_NODE_VERSION: &str = "v22.17.0";

fn managed_toolchain_dir_in(home: &std::path::Path) -> PathBuf {
    home.join("Library")
        .join("Application Support")
        .join("Indigo HQ")
        .join("toolchain")
}

fn managed_node_dir_in(home: &std::path::Path) -> PathBuf {
    managed_toolchain_dir_in(home).join("node")
}

fn managed_node_bin_in(home: &std::path::Path) -> PathBuf {
    managed_node_dir_in(home).join("bin")
}

fn managed_npm_prefix_in(home: &std::path::Path) -> PathBuf {
    managed_toolchain_dir_in(home).join("npm-global")
}

fn managed_npm_bin_in(home: &std::path::Path) -> PathBuf {
    managed_npm_prefix_in(home).join("bin")
}

/// User-local tool paths owned by HQ Installer. Exposed for unit tests.
pub fn managed_tool_paths_in(home: &std::path::Path) -> Vec<String> {
    vec![
        managed_node_bin_in(home).to_string_lossy().into_owned(),
        managed_npm_bin_in(home).to_string_lossy().into_owned(),
    ]
}

/// Map Rust's `std::env::consts::ARCH` values to Node's darwin tarball names.
/// Exposed for unit tests so the download URL stays deterministic.
pub fn node_dist_arch_for(arch: &str) -> Option<&'static str> {
    match arch {
        "aarch64" => Some("arm64"),
        "x86_64" => Some("x64"),
        _ => None,
    }
}

fn managed_node_url_for(arch: &str) -> Option<String> {
    let node_arch = node_dist_arch_for(arch)?;
    Some(format!(
        "https://nodejs.org/dist/{MANAGED_NODE_VERSION}/node-{MANAGED_NODE_VERSION}-darwin-{node_arch}.tar.gz"
    ))
}

fn home_dir_or_err(app: &AppHandle, tool: &str) -> Result<PathBuf, String> {
    dirs::home_dir().ok_or_else(|| {
        let msg = format!("[{tool}] could not resolve home directory");
        emit_preflight_line(app, &msg);
        msg
    })
}

fn npm_global_prefix_arg(app: &AppHandle, tool: &str) -> Result<String, String> {
    let home = home_dir_or_err(app, tool)?;
    let prefix = managed_npm_prefix_in(&home);
    if let Err(e) = std::fs::create_dir_all(&prefix) {
        let msg = format!(
            "[{tool}] failed to create npm prefix {}: {e}",
            prefix.display()
        );
        emit_preflight_line(app, &msg);
        return Err(msg);
    }
    Ok(prefix.to_string_lossy().into_owned())
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
    if let std::collections::hash_map::Entry::Occupied(mut e) = reg.entry(handle) {
        e.insert(true);
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
async fn run_streaming(app: &AppHandle, program: &str, args: &[&str]) -> Result<String, String> {
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

/// Install Node.js into HQ's user-local managed toolchain.
///
/// The installer used to require Homebrew here, which stranded fresh Macs
/// where the first user was not an Administrator. Node/npm/npx do not require
/// a system package manager, so we download the official darwin tarball into:
/// `~/Library/Application Support/Indigo HQ/toolchain/node`.
#[tauri::command]
pub async fn install_node(app: AppHandle) -> Result<String, String> {
    let home = home_dir_or_err(&app, "node")?;
    let toolchain_dir = managed_toolchain_dir_in(&home);
    let node_dir = managed_node_dir_in(&home);
    let node_bin = managed_node_bin_in(&home).join("node");

    if node_bin.exists() {
        emit_preflight_line(
            &app,
            &format!(
                "[node] managed Node already present at {}",
                node_bin.display()
            ),
        );
        return Ok(format!("node already installed at {}", node_bin.display()));
    }

    let Some(url) = managed_node_url_for(std::env::consts::ARCH) else {
        let msg = format!(
            "[node] unsupported arch '{}' — cannot install managed Node",
            std::env::consts::ARCH
        );
        emit_preflight_line(&app, &msg);
        return Err(msg);
    };

    if let Err(e) = std::fs::create_dir_all(&node_dir) {
        let msg = format!("[node] failed to create {}: {e}", node_dir.display());
        emit_preflight_line(&app, &msg);
        return Err(msg);
    }

    let archive = toolchain_dir.join(format!("node-{MANAGED_NODE_VERSION}-darwin.tar.gz"));
    let archive_str = archive.to_string_lossy().into_owned();
    let node_dir_str = node_dir.to_string_lossy().into_owned();

    emit_preflight_line(
        &app,
        &format!("[node] downloading {url} → {}", archive.display()),
    );
    run_streaming(&app, "/usr/bin/curl", &["-fsSL", "-o", &archive_str, &url]).await?;

    emit_preflight_line(
        &app,
        &format!("[node] extracting to {}", node_dir.display()),
    );
    run_streaming(
        &app,
        "/usr/bin/tar",
        &[
            "-xzf",
            &archive_str,
            "-C",
            &node_dir_str,
            "--strip-components",
            "1",
        ],
    )
    .await?;

    if !node_bin.exists() {
        let msg = format!(
            "[node] install completed but node binary was not found at {}",
            node_bin.display()
        );
        emit_preflight_line(&app, &msg);
        return Err(msg);
    }

    Ok(format!("node installed at {}", node_bin.display()))
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
            let msg = "Git CLI is optional for HQ setup. Install Homebrew or Xcode Command Line Tools later if you want the system git command.";
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
            let msg = "GitHub CLI is optional. Install Homebrew later if you want hq-installer to add gh automatically.";
            emit_preflight_line(&app, msg);
            return Err(msg.to_string());
        }
    };
    run_streaming(&app, brew.to_str().unwrap_or("brew"), &["install", "gh"]).await
}

// ─────────────────────────────────────────────────────────────────────────────
// install_yq
// ─────────────────────────────────────────────────────────────────────────────

/// Pinned `mikefarah/yq` version for the binary fallback. Matches what
/// Homebrew was shipping at the time this fallback was added; bump alongside
/// installer releases so support reproductions stay deterministic.
const YQ_BINARY_VERSION: &str = "v4.53.2";

/// Install yq.
///
/// Strategy: try `brew install yq` first, fall back to a direct binary
/// download from `mikefarah/yq`'s GitHub releases when brew fails or is
/// missing.
///
/// **Why the fallback exists:** the Homebrew formula declares `pandoc` as a
/// build-time dep (just for the man page). On macOS configs without prebuilt
/// bottles available (Tier 2/3 — older OS, outdated Command Line Tools),
/// brew falls through to building pandoc from source, which drags in
/// `cabal-install` + `ghc` and fails. yq itself is a single static Go
/// binary, so we sidestep the Haskell toolchain by grabbing the prebuilt
/// asset directly.
///
/// The fallback writes to `~/.local/bin/yq`, which is already on
/// `extended_search_path()` — the post-install `which yq` check picks it up
/// without PATH wiring. No sudo required.
///
/// Required by the Workspace integrity scripts (compute-checksums.sh,
/// core-integrity.sh) that read/write scripts/core.yaml.
#[tauri::command]
pub async fn install_yq(app: AppHandle) -> Result<String, String> {
    if let Ok(brew) = which::which_in(
        "brew",
        Some(extended_search_path()),
        std::env::current_dir().unwrap_or_default(),
    ) {
        let brew_str = brew.to_str().unwrap_or("brew").to_string();
        match run_streaming(&app, &brew_str, &["install", "yq"]).await {
            Ok(out) => return Ok(out),
            Err(brew_err) => {
                let first_line = brew_err.lines().next().unwrap_or("error");
                emit_preflight_line(
                    &app,
                    &format!(
                        "[yq] brew install failed ({first_line}); falling back to direct binary download"
                    ),
                );
            }
        }
    } else {
        emit_preflight_line(
            &app,
            "[yq] Homebrew not found; installing via direct binary download",
        );
    }

    install_yq_via_binary(&app).await
}

/// Download `mikefarah/yq`'s prebuilt darwin binary into `~/.local/bin/yq`.
///
/// `~/.local/bin` is already part of `extended_search_path()` (see the
/// `extras` block there), so the installer's existing `which yq` probe picks
/// the binary up the same way it would a brew-installed yq. No sudo, no
/// PATH wiring on the user's side.
async fn install_yq_via_binary(app: &AppHandle) -> Result<String, String> {
    let arch = match std::env::consts::ARCH {
        "aarch64" => "arm64",
        "x86_64" => "amd64",
        other => {
            let msg =
                format!("[yq] unsupported arch '{other}' — cannot install yq via binary fallback");
            emit_preflight_line(app, &msg);
            return Err(msg);
        }
    };

    let url = format!(
        "https://github.com/mikefarah/yq/releases/download/{YQ_BINARY_VERSION}/yq_darwin_{arch}"
    );

    let Some(home) = dirs::home_dir() else {
        let msg = "[yq] could not resolve home directory".to_string();
        emit_preflight_line(app, &msg);
        return Err(msg);
    };
    let bin_dir = home.join(".local").join("bin");
    let target = bin_dir.join("yq");

    if let Err(e) = std::fs::create_dir_all(&bin_dir) {
        let msg = format!("[yq] failed to create {}: {e}", bin_dir.display());
        emit_preflight_line(app, &msg);
        return Err(msg);
    }

    emit_preflight_line(
        app,
        &format!("[yq] downloading {url} → {}", target.display()),
    );

    let target_str = target.to_string_lossy().into_owned();

    // curl flags: -f fails on HTTP error (so a 404 surfaces instead of
    // writing an HTML error page to disk and chmod'ing it +x), -sS keeps
    // the progress bar quiet but still emits errors to stderr (which
    // `run_streaming` captures), -L follows redirects (GitHub redirects
    // release assets to S3).
    run_streaming(app, "curl", &["-fsSL", "-o", &target_str, &url]).await?;
    run_streaming(app, "chmod", &["+x", &target_str]).await?;

    Ok(format!("yq installed at {}", target.display()))
}

// ─────────────────────────────────────────────────────────────────────────────
// install_claude_code
// ─────────────────────────────────────────────────────────────────────────────

/// Install the Claude Code CLI via `npm install -g @anthropic-ai/claude-code`.
///
/// Errors if npm is not available.
#[tauri::command]
pub async fn install_claude_code(app: AppHandle) -> Result<String, String> {
    let prefix = npm_global_prefix_arg(&app, "claude")?;
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
        &[
            "install",
            "-g",
            "--prefix",
            &prefix,
            "@anthropic-ai/claude-code",
        ],
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
    let prefix = npm_global_prefix_arg(&app, "qmd")?;
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
        &["install", "-g", "--prefix", &prefix, "@tobilu/qmd"],
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
