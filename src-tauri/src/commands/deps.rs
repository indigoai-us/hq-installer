//! Dependency probe and install commands for the HQ installer.
//!
//! Each installer streams stdout lines to the frontend via `install:progress`
//! events and supports cancellation through a shared handle registry. Required
//! tools use a user-local HQ-managed toolchain when possible; Homebrew remains
//! an optional system package-manager provider.

use std::collections::HashMap;
use std::io::{BufRead, BufReader};
#[cfg(windows)]
use std::mem::size_of;
#[cfg(unix)]
use std::os::unix::process::CommandExt as _;
#[cfg(windows)]
use std::os::windows::io::AsRawHandle;
#[cfg(windows)]
use std::os::windows::process::CommandExt as _;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;
#[cfg(not(windows))]
use std::time::Instant;

#[cfg(unix)]
use nix::sys::signal::{self, Signal};
#[cfg(unix)]
use nix::unistd::Pid;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use uuid::Uuid;
#[cfg(windows)]
use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, HWND};
#[cfg(windows)]
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
    SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};
#[cfg(windows)]
use windows_sys::Win32::UI::WindowsAndMessaging::{
    SendMessageTimeoutW, HWND_BROADCAST, SMTO_ABORTIFHUNG, WM_SETTINGCHANGE,
};
#[cfg(windows)]
use winreg::enums::{HKEY_CURRENT_USER, KEY_READ, KEY_SET_VALUE, REG_EXPAND_SZ, REG_SZ};
#[cfg(windows)]
use winreg::{RegKey, RegValue};

// ─────────────────────────────────────────────────────────────────────────────
// Cancel registry
// ─────────────────────────────────────────────────────────────────────────────

/// Global map from install-handle → cancellation state and process-tree kill target.
static CANCEL_REGISTRY: std::sync::OnceLock<Arc<Mutex<HashMap<String, CancelState>>>> =
    std::sync::OnceLock::new();

#[derive(Default)]
struct CancelState {
    cancelled: bool,
    kill_error: Option<String>,
    #[cfg(unix)]
    pgid: Option<i32>,
    #[cfg(windows)]
    job: Option<Arc<JobHandle>>,
}

fn cancel_registry() -> &'static Arc<Mutex<HashMap<String, CancelState>>> {
    CANCEL_REGISTRY.get_or_init(|| Arc::new(Mutex::new(HashMap::new())))
}

/// Register a new cancel handle (called at the start of every install).
/// Exposed publicly so the test suite can exercise `cancel_install` without
/// spawning a real Tauri runtime.
pub fn register_cancel_handle(handle: String) {
    cancel_registry()
        .lock()
        .unwrap()
        .insert(handle, CancelState::default());
}

fn is_cancelled(handle: &str) -> bool {
    cancel_registry()
        .lock()
        .unwrap()
        .get(handle)
        .map(|state| state.cancelled)
        .unwrap_or(false)
}

fn deregister_handle(handle: &str) {
    cancel_registry().lock().unwrap().remove(handle);
}

#[cfg(unix)]
fn register_process_group(handle: &str, pgid: i32) {
    if let Some(state) = cancel_registry().lock().unwrap().get_mut(handle) {
        state.pgid = Some(pgid);
    }
}

#[cfg(windows)]
fn register_job_handle(handle: &str, job: Arc<JobHandle>) {
    if let Some(state) = cancel_registry().lock().unwrap().get_mut(handle) {
        state.job = Some(job);
    }
}

fn record_kill_error(handle: &str, err: String) {
    if let Some(state) = cancel_registry().lock().unwrap().get_mut(handle) {
        state.kill_error = Some(err);
    }
}

fn take_kill_error(handle: &str) -> Option<String> {
    cancel_registry()
        .lock()
        .unwrap()
        .get_mut(handle)
        .and_then(|state| state.kill_error.take())
}

#[cfg(unix)]
fn terminate_process_tree(handle: &str, signal_kind: Signal) -> Result<(), String> {
    let pgid = cancel_registry()
        .lock()
        .unwrap()
        .get(handle)
        .and_then(|state| state.pgid);
    let Some(pgid) = pgid else {
        return Ok(());
    };

    match signal::kill(Pid::from_raw(-pgid), signal_kind) {
        Ok(()) | Err(nix::errno::Errno::ESRCH) => Ok(()),
        Err(e) => Err(format!(
            "failed to send {signal_kind:?} to install process group {pgid}: {e}"
        )),
    }
}

#[cfg(windows)]
fn terminate_process_tree(handle: &str) -> Result<(), String> {
    let job = cancel_registry()
        .lock()
        .unwrap()
        .get(handle)
        .and_then(|state| state.job.clone());
    let Some(job) = job else {
        return Ok(());
    };

    let result = unsafe { TerminateJobObject(job.0, 1) };
    if result == 0 {
        return Err(format!(
            "TerminateJobObject failed: {}",
            std::io::Error::last_os_error()
        ));
    }
    Ok(())
}

#[cfg(windows)]
struct JobHandle(HANDLE);

#[cfg(windows)]
unsafe impl Send for JobHandle {}
#[cfg(windows)]
unsafe impl Sync for JobHandle {}

#[cfg(windows)]
impl Drop for JobHandle {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
}

#[cfg(windows)]
fn create_job_object() -> Result<JobHandle, String> {
    let job = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
    if job.is_null() {
        return Err(format!(
            "CreateJobObjectW failed: {}",
            std::io::Error::last_os_error()
        ));
    }

    let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
    info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    let result = unsafe {
        SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &info as *const _ as *const _,
            size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        )
    };
    if result == 0 {
        let err = std::io::Error::last_os_error();
        unsafe {
            CloseHandle(job);
        }
        return Err(format!("SetInformationJobObject failed: {err}"));
    }

    Ok(JobHandle(job))
}

#[cfg(windows)]
fn assign_process_to_job(job: HANDLE, process: HANDLE) -> Result<(), String> {
    let result = unsafe { AssignProcessToJobObject(job, process) };
    if result == 0 {
        return Err(format!(
            "AssignProcessToJobObject failed: {}",
            std::io::Error::last_os_error()
        ));
    }
    Ok(())
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
#[cfg(not(windows))]
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
#[cfg(not(windows))]
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
#[cfg(not(windows))]
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
#[cfg(not(windows))]
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
#[cfg(not(windows))]
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
#[cfg(not(windows))]
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
#[cfg(not(windows))]
pub fn extended_search_path() -> String {
    extended_search_path_in(None)
}

/// Same composition as `extended_search_path()` but accepts an explicit
/// home-directory override so tests can exercise version-manager discovery
/// against a fixture directory without mutating process-global HOME.
///
/// When `home` is `None`, resolves via `dirs::home_dir()` (production path).
#[cfg(not(windows))]
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
#[cfg(not(windows))]
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
#[cfg(not(windows))]
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
#[cfg(not(windows))]
const MANAGED_NODE_VERSION: &str = "v22.17.0";
#[cfg(not(windows))]
const MANAGED_NODE_SHA256_ARM64: &str =
    "615dda58b5fb41fad2be43940b6398ca56554cbe05800953afadc724729cb09e";
#[cfg(not(windows))]
const MANAGED_NODE_SHA256_X64: &str =
    "c39c8ec3cdadedfcc75de0cb3305df95ae2aecebc5db8d68a9b67bd74616d2ad";

/// Pinned portable Git from dugite-native (GitHub Desktop's embedded Git).
/// Self-contained — runs with no Xcode Command Line Tools, Homebrew, or admin.
/// HQ requires the git CLI for autocommit, repo work, agents, and pack install,
/// so we provision it into the managed toolchain like Node/qmd rather than
/// leaving the user to install it. Bump deliberately and refresh BOTH per-arch
/// SHA-256s from the release's `*.tar.gz.sha256` assets.
#[cfg(not(windows))]
const MANAGED_GIT_RELEASE: &str = "v2.53.0-3";
#[cfg(not(windows))]
const MANAGED_GIT_BUILD: &str = "v2.53.0-f49d009";
#[cfg(not(windows))]
const MANAGED_GIT_SHA256_ARM64: &str =
    "e561cfc80c755e6f3e938653e81efcd025c9827a5b76dd42778b1159b3fab437";
#[cfg(not(windows))]
const MANAGED_GIT_SHA256_X64: &str =
    "caf27c36b8834969550535bcd5e58186f970e080d1e175e76d9c1de3aac409ed";

fn unique_sibling_path(target: &Path, suffix: &str) -> Result<PathBuf, String> {
    let parent = target
        .parent()
        .ok_or_else(|| format!("target has no parent: {}", target.display()))?;
    let name = target
        .file_name()
        .ok_or_else(|| format!("target has no file name: {}", target.display()))?
        .to_string_lossy();
    Ok(parent.join(format!(".{name}.{suffix}.{}", Uuid::new_v4())))
}

fn atomic_replace_file(staged: &Path, target: &Path) -> Result<(), String> {
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
    }

    if !target.exists() {
        return std::fs::rename(staged, target).map_err(|e| {
            format!(
                "rename {} -> {} failed: {e}",
                staged.display(),
                target.display()
            )
        });
    }

    let backup = unique_sibling_path(target, "bak")?;
    std::fs::rename(target, &backup).map_err(|e| {
        format!(
            "backup existing {} -> {} failed: {e}",
            target.display(),
            backup.display()
        )
    })?;

    match std::fs::rename(staged, target) {
        Ok(()) => {
            std::fs::remove_file(&backup)
                .map_err(|e| format!("remove backup {} failed: {e}", backup.display()))?;
            Ok(())
        }
        Err(rename_err) => {
            let restore_result = std::fs::rename(&backup, target);
            Err(match restore_result {
                Ok(()) => format!(
                    "rename {} -> {} failed: {rename_err}",
                    staged.display(),
                    target.display()
                ),
                Err(restore_err) => format!(
                    "rename {} -> {} failed: {rename_err}; restore {} -> {} failed: {restore_err}",
                    staged.display(),
                    target.display(),
                    backup.display(),
                    target.display()
                ),
            })
        }
    }
}

fn atomic_replace_dir(staged: &Path, target: &Path) -> Result<(), String> {
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
    }

    if !target.exists() {
        return std::fs::rename(staged, target).map_err(|e| {
            format!(
                "rename {} -> {} failed: {e}",
                staged.display(),
                target.display()
            )
        });
    }

    let backup = unique_sibling_path(target, "bak")?;
    std::fs::rename(target, &backup).map_err(|e| {
        format!(
            "backup existing {} -> {} failed: {e}",
            target.display(),
            backup.display()
        )
    })?;

    match std::fs::rename(staged, target) {
        Ok(()) => {
            std::fs::remove_dir_all(&backup)
                .map_err(|e| format!("remove backup {} failed: {e}", backup.display()))?;
            Ok(())
        }
        Err(rename_err) => {
            let restore_result = std::fs::rename(&backup, target);
            Err(match restore_result {
                Ok(()) => format!(
                    "rename {} -> {} failed: {rename_err}",
                    staged.display(),
                    target.display()
                ),
                Err(restore_err) => format!(
                    "rename {} -> {} failed: {rename_err}; restore {} -> {} failed: {restore_err}",
                    staged.display(),
                    target.display(),
                    backup.display(),
                    target.display()
                ),
            })
        }
    }
}

#[cfg(not(windows))]
fn managed_toolchain_dir_in(home: &std::path::Path) -> PathBuf {
    home.join("Library")
        .join("Application Support")
        .join("Indigo HQ")
        .join("toolchain")
}

#[cfg(not(windows))]
fn managed_node_dir_in(home: &std::path::Path) -> PathBuf {
    managed_toolchain_dir_in(home).join("node")
}

#[cfg(not(windows))]
fn managed_node_bin_in(home: &std::path::Path) -> PathBuf {
    managed_node_dir_in(home).join("bin")
}

#[cfg(not(windows))]
fn managed_npm_prefix_in(home: &std::path::Path) -> PathBuf {
    managed_toolchain_dir_in(home).join("npm-global")
}

#[cfg(not(windows))]
fn managed_npm_bin_in(home: &std::path::Path) -> PathBuf {
    managed_npm_prefix_in(home).join("bin")
}

#[cfg(not(windows))]
fn managed_git_dir_in(home: &std::path::Path) -> PathBuf {
    managed_toolchain_dir_in(home).join("git")
}

#[cfg(not(windows))]
fn managed_git_bin_in(home: &std::path::Path) -> PathBuf {
    managed_git_dir_in(home).join("bin")
}

/// Environment a relocatable (dugite) git needs so it can find its sub-commands
/// (libexec/git-core, e.g. git-remote-https), its templates, and a CA bundle.
/// dugite's git has no compiled-in prefix and bundles no CA file, so without
/// these `git clone https://…` fails first with "remote-https is not a git
/// command" and then with a certificate-verify error. Returns empty when the
/// managed git isn't installed (so a real system git keeps its own config).
/// Exposed for unit tests.
#[cfg(not(windows))]
pub fn managed_git_env_in(home: &std::path::Path) -> Vec<(String, String)> {
    let git_dir = managed_git_dir_in(home);
    if !git_dir.join("bin").join("git").exists() {
        return Vec::new();
    }
    let mut env = vec![
        (
            "GIT_EXEC_PATH".to_string(),
            git_dir
                .join("libexec")
                .join("git-core")
                .to_string_lossy()
                .into_owned(),
        ),
        (
            "GIT_TEMPLATE_DIR".to_string(),
            git_dir
                .join("share")
                .join("git-core")
                .join("templates")
                .to_string_lossy()
                .into_owned(),
        ),
    ];
    // dugite's git uses OpenSSL and bundles no CA; macOS ships a trusted bundle
    // at /etc/ssl/cert.pem. Only set it when present.
    let system_ca = std::path::Path::new("/etc/ssl/cert.pem");
    if system_ca.exists() {
        env.push((
            "GIT_SSL_CAINFO".to_string(),
            system_ca.to_string_lossy().into_owned(),
        ));
    }
    env
}

/// Production wrapper over `managed_git_env_in`, resolving the real home dir.
#[cfg(not(windows))]
pub fn managed_git_env() -> Vec<(String, String)> {
    dirs::home_dir()
        .map(|h| managed_git_env_in(&h))
        .unwrap_or_default()
}

/// User-local tool paths owned by HQ Installer. Exposed for unit tests.
#[cfg(not(windows))]
pub fn managed_tool_paths_in(home: &std::path::Path) -> Vec<String> {
    vec![
        managed_node_bin_in(home).to_string_lossy().into_owned(),
        managed_npm_bin_in(home).to_string_lossy().into_owned(),
        managed_git_bin_in(home).to_string_lossy().into_owned(),
    ]
}

/// Map Rust's `std::env::consts::ARCH` values to Node's darwin tarball names.
/// Exposed for unit tests so the download URL stays deterministic.
#[cfg(not(windows))]
pub fn node_dist_arch_for(arch: &str) -> Option<&'static str> {
    match arch {
        "aarch64" => Some("arm64"),
        "x86_64" => Some("x64"),
        _ => None,
    }
}

#[cfg(not(windows))]
fn managed_node_url_for(arch: &str) -> Option<String> {
    let node_arch = node_dist_arch_for(arch)?;
    Some(format!(
        "https://nodejs.org/dist/{MANAGED_NODE_VERSION}/node-{MANAGED_NODE_VERSION}-darwin-{node_arch}.tar.gz"
    ))
}

#[cfg(not(windows))]
fn managed_node_sha256_for(arch: &str) -> Option<&'static str> {
    match arch {
        "aarch64" => Some(MANAGED_NODE_SHA256_ARM64),
        "x86_64" => Some(MANAGED_NODE_SHA256_X64),
        _ => None,
    }
}

/// dugite-native publishes per-arch macOS tarballs as `...-macOS-{arm64,x64}`.
/// Reuses `node_dist_arch_for` since dugite uses the same arch tokens as Node.
#[cfg(not(windows))]
fn managed_git_url_for(arch: &str) -> Option<String> {
    let git_arch = node_dist_arch_for(arch)?;
    Some(format!(
        "https://github.com/desktop/dugite-native/releases/download/{MANAGED_GIT_RELEASE}/dugite-native-{MANAGED_GIT_BUILD}-macOS-{git_arch}.tar.gz"
    ))
}

/// Pinned SHA-256 for the dugite-native tarball, per arch.
#[cfg(not(windows))]
fn managed_git_sha256_for(arch: &str) -> Option<&'static str> {
    match arch {
        "aarch64" => Some(MANAGED_GIT_SHA256_ARM64),
        "x86_64" => Some(MANAGED_GIT_SHA256_X64),
        _ => None,
    }
}

#[cfg(not(windows))]
fn home_dir_or_err(app: &AppHandle, tool: &str) -> Result<PathBuf, String> {
    dirs::home_dir().ok_or_else(|| {
        let msg = format!("[{tool}] could not resolve home directory");
        emit_preflight_line(app, &msg);
        msg
    })
}

#[cfg(not(windows))]
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
    ensure_shell_path_configured(&home, app);
    Ok(prefix.to_string_lossy().into_owned())
}

// ─────────────────────────────────────────────────────────────────────────────
// Shell profile PATH injection
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(not(windows))]
const SHELL_PATH_MARKER: &str = "# Indigo HQ managed toolchain";

/// Resolve which shell profile file to modify.
///
/// Modern macOS defaults to zsh (since Catalina 10.15), so `.zshrc` is the
/// primary target. Falls back to `.bash_profile` for bash users or `.profile`
/// for anything else. Exposed for testing.
#[cfg(not(windows))]
pub fn shell_profile_path_in(home: &std::path::Path) -> PathBuf {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let profile_name = if shell.ends_with("/zsh") {
        ".zshrc"
    } else if shell.ends_with("/bash") {
        ".bash_profile"
    } else {
        ".profile"
    };
    home.join(profile_name)
}

/// Check whether the managed toolchain PATH block has already been written to
/// a shell profile. Exposed for testing.
#[cfg(not(windows))]
pub fn is_shell_path_configured(profile_path: &std::path::Path) -> bool {
    std::fs::read_to_string(profile_path)
        .map(|contents| contents.contains(SHELL_PATH_MARKER))
        .unwrap_or(false)
}

/// Build the block that gets appended to the shell profile. Exposed for
/// testing so assertions don't depend on the home directory.
#[cfg(not(windows))]
pub fn shell_path_block() -> String {
    format!(
        "\n{SHELL_PATH_MARKER}\nexport PATH=\"$HOME/Library/Application Support/Indigo HQ/toolchain/node/bin:$HOME/Library/Application Support/Indigo HQ/toolchain/npm-global/bin:$PATH\"\n"
    )
}

/// Ensure the managed toolchain bin directories are present in the user's
/// shell profile so that `hq`, `qmd`, `claude`, and `node`/`npm` are
/// discoverable from interactive terminal sessions.
///
/// This is the macOS equivalent of writing the install path to the Windows
/// system PATH environment variable. On macOS, PATH is configured per-shell
/// via profile scripts (`.zshrc`, `.bash_profile`, `.profile`).
///
/// Idempotent — checks for a marker comment before writing. Failures are
/// non-fatal and logged via `emit_preflight_line`.
#[cfg(not(windows))]
fn ensure_shell_path_configured(home: &std::path::Path, app: &AppHandle) {
    let profile_path = shell_profile_path_in(home);

    if is_shell_path_configured(&profile_path) {
        return;
    }

    let block = shell_path_block();

    match std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&profile_path)
    {
        Ok(mut f) => {
            use std::io::Write;
            if let Err(e) = f.write_all(block.as_bytes()) {
                emit_preflight_line(
                    app,
                    &format!("[path] failed to write to {}: {e}", profile_path.display()),
                );
            } else {
                emit_preflight_line(
                    app,
                    &format!(
                        "[path] added HQ toolchain to {} — restart your terminal or run: source {}",
                        profile_path.display(),
                        profile_path.display()
                    ),
                );
            }
        }
        Err(e) => {
            emit_preflight_line(
                app,
                &format!("[path] failed to open {}: {e}", profile_path.display()),
            );
        }
    }
}

/// Internal implementation shared by `check_dep` (uses real PATH) and
/// `check_dep_in` (uses a caller-supplied search path — useful for tests).
/// True when `(tool, bin_path)` is the macOS `/usr/bin/git` CLT shim. Pure so
/// the path classification is unit-tested without filesystem/xcode-select; the
/// caller layers the CLT-presence check on top to decide "usable or not".
#[cfg(not(windows))]
pub fn is_macos_git_shim(tool: &str, bin_path: &std::path::Path) -> bool {
    tool == "git" && bin_path == std::path::Path::new("/usr/bin/git")
}

#[cfg(not(windows))]
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

    // macOS ships a non-functional `git` shim at /usr/bin/git that forwards to
    // the Xcode Command Line Tools. With no CLT installed it can't run git — it
    // errors and pops the "install developer tools" dialog. Treat it as NOT
    // installed so the managed (dugite) git gets provisioned instead. Detected
    // via path + `xcode-select -p` so we never RUN the shim (running it is what
    // pops the dialog). Once the toolchain git is installed, which_in resolves
    // to it first (toolchain is ahead of /usr/bin), so this guard stops firing.
    if is_macos_git_shim(tool, &bin_path) {
        let clt_present = Command::new("/usr/bin/xcode-select")
            .arg("-p")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        if !clt_present {
            return DepStatus {
                installed: false,
                version: None,
                path: None,
            };
        }
    }

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
#[cfg(not(windows))]
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
    let Some(state) = reg.get_mut(&handle) else {
        return false;
    };
    state.cancelled = true;
    drop(reg);

    #[cfg(unix)]
    if let Err(e) = terminate_process_tree(&handle, Signal::SIGTERM) {
        record_kill_error(&handle, e);
    }
    #[cfg(windows)]
    if let Err(e) = terminate_process_tree(&handle) {
        record_kill_error(&handle, e);
    }

    true
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
#[cfg(not(windows))]
async fn run_streaming(app: &AppHandle, program: &str, args: &[&str]) -> Result<String, String> {
    let handle_id = Uuid::new_v4().to_string();
    register_cancel_handle(handle_id.clone());

    let mut command = Command::new(program);
    command
        .args(args)
        .env("PATH", extended_search_path())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    command.process_group(0);

    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(e) => {
            deregister_handle(&handle_id);
            return Err(format!("Failed to spawn '{}': {}", program, e));
        }
    };
    register_process_group(&handle_id, child.id() as i32);

    let stdout = match child.stdout.take() {
        Some(stdout) => stdout,
        None => {
            deregister_handle(&handle_id);
            return Err("no stdout".to_string());
        }
    };
    let stderr = match child.stderr.take() {
        Some(stderr) => stderr,
        None => {
            deregister_handle(&handle_id);
            return Err("no stderr".to_string());
        }
    };

    enum ReaderMsg {
        Stdout(String),
        Stderr,
        Done {
            stream: &'static str,
            err: Option<String>,
        },
    }

    // Drain stderr in a background thread — see the function doc above for why.
    let stderr_lines: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let (tx, rx) = mpsc::channel::<ReaderMsg>();
    let stdout_thread = {
        let tx = tx.clone();
        std::thread::spawn(move || {
            let mut err = None;
            for line_result in BufReader::new(stdout).lines() {
                match line_result {
                    Ok(line) => {
                        if tx.send(ReaderMsg::Stdout(line)).is_err() {
                            return;
                        }
                    }
                    Err(e) => {
                        err = Some(e.to_string());
                        break;
                    }
                }
            }
            let _ = tx.send(ReaderMsg::Done {
                stream: "stdout",
                err,
            });
        })
    };
    let stderr_thread = {
        let app = app.clone();
        let handle_id = handle_id.clone();
        let stderr_lines = Arc::clone(&stderr_lines);
        let tx = tx.clone();
        std::thread::spawn(move || {
            let mut err = None;
            for line_result in BufReader::new(stderr).lines() {
                match line_result {
                    Ok(line) => {
                        stderr_lines.lock().unwrap().push(line.clone());
                        let _ = app.emit(
                            "install:progress",
                            InstallProgress {
                                handle: handle_id.clone(),
                                line: line.clone(),
                                finished: false,
                                error: None,
                            },
                        );
                        if tx.send(ReaderMsg::Stderr).is_err() {
                            return;
                        }
                    }
                    Err(e) => {
                        err = Some(e.to_string());
                        break;
                    }
                }
            }
            let _ = tx.send(ReaderMsg::Done {
                stream: "stderr",
                err,
            });
        })
    };
    drop(tx);

    let mut done_count = 0;
    let mut first_stream_err: Option<String> = None;
    let mut status = None;
    let mut cancel_started: Option<Instant> = None;
    let mut sigkill_sent = false;

    loop {
        match rx.recv_timeout(Duration::from_millis(100)) {
            Ok(ReaderMsg::Stdout(line)) => {
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
            Ok(ReaderMsg::Stderr) => {}
            Ok(ReaderMsg::Done { stream, err }) => {
                if let Some(e) = err {
                    if first_stream_err.is_none() {
                        first_stream_err = Some(format!("{stream}: {e}"));
                    }
                }
                done_count += 1;
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }

        if is_cancelled(&handle_id) {
            if cancel_started.is_none() {
                if let Err(e) = terminate_process_tree(&handle_id, Signal::SIGTERM) {
                    record_kill_error(&handle_id, e);
                }
                cancel_started = Some(Instant::now());
            } else if !sigkill_sent
                && cancel_started
                    .map(|started| started.elapsed() >= Duration::from_secs(2))
                    .unwrap_or(false)
            {
                if let Err(e) = terminate_process_tree(&handle_id, Signal::SIGKILL) {
                    record_kill_error(&handle_id, e);
                }
                sigkill_sent = true;
            }
        }

        if status.is_none() {
            status = child.try_wait().map_err(|e| e.to_string())?;
        }
        if status.is_some() && done_count >= 2 {
            break;
        }
        if done_count >= 2 && status.is_none() {
            status = Some(child.wait().map_err(|e| e.to_string())?);
            break;
        }
    }

    let status = match status {
        Some(status) => status,
        None => child.wait().map_err(|e| e.to_string())?,
    };

    let stdout_join = stdout_thread
        .join()
        .map_err(|_| "stdout reader thread panicked".to_string());
    let stderr_join = stderr_thread
        .join()
        .map_err(|_| "stderr reader thread panicked".to_string());

    let was_cancelled = is_cancelled(&handle_id);
    let kill_error = take_kill_error(&handle_id);
    deregister_handle(&handle_id);

    if let Err(e) = stdout_join.and(stderr_join) {
        let _ = app.emit(
            "install:progress",
            InstallProgress {
                handle: handle_id.clone(),
                line: String::new(),
                finished: true,
                error: Some(e.clone()),
            },
        );
        return Err(e);
    }

    if was_cancelled {
        let msg = match kill_error {
            Some(e) => format!("Cancelled by user; {e}"),
            None => "Cancelled by user".to_string(),
        };
        let _ = app.emit(
            "install:progress",
            InstallProgress {
                handle: handle_id.clone(),
                line: String::new(),
                finished: true,
                error: Some(msg.clone()),
            },
        );
        return Err(msg);
    }

    if let Some(err) = first_stream_err {
        let _ = app.emit(
            "install:progress",
            InstallProgress {
                handle: handle_id.clone(),
                line: String::new(),
                finished: true,
                error: Some(err.clone()),
            },
        );
        return Err(err);
    }

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
///
/// Only the macOS install path emits preflight lines; the Windows installers
/// surface their own progress, so this is `#[cfg(not(windows))]` to avoid a
/// dead-code warning on Windows.
#[cfg(not(windows))]
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
#[cfg(not(windows))]
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
#[cfg(not(windows))]
async fn install_node_macos(app: AppHandle) -> Result<String, String> {
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

    let arch = std::env::consts::ARCH;
    let Some(url) = managed_node_url_for(arch) else {
        let msg = format!(
            "[node] unsupported arch '{}' — cannot install managed Node",
            arch
        );
        emit_preflight_line(&app, &msg);
        return Err(msg);
    };
    let Some(expected_sha) = managed_node_sha256_for(arch) else {
        let msg = format!("[node] no pinned checksum for arch '{arch}'");
        emit_preflight_line(&app, &msg);
        return Err(msg);
    };

    if let Err(e) = std::fs::create_dir_all(&toolchain_dir) {
        let msg = format!(
            "[node] failed to create toolchain dir {}: {e}",
            toolchain_dir.display()
        );
        emit_preflight_line(&app, &msg);
        return Err(msg);
    }

    let archive = toolchain_dir.join(format!(
        ".node-{MANAGED_NODE_VERSION}-darwin.{}.tar.gz.tmp",
        Uuid::new_v4()
    ));
    let archive_str = archive.to_string_lossy().into_owned();
    let staged_dir = toolchain_dir.join(format!(".node-install-{}", Uuid::new_v4()));
    let staged_bin = staged_dir.join("bin").join("node");
    let staged_dir_str = staged_dir.to_string_lossy().into_owned();

    emit_preflight_line(
        &app,
        &format!("[node] downloading {url} → {}", archive.display()),
    );
    run_streaming(&app, "/usr/bin/curl", &["-fsSL", "-o", &archive_str, &url]).await?;

    let check_path = toolchain_dir.join(format!(".node-{MANAGED_NODE_VERSION}.sha256"));
    let check_str = check_path.to_string_lossy().into_owned();
    if let Err(e) = std::fs::write(&check_path, format!("{expected_sha}  {archive_str}\n")) {
        let _ = std::fs::remove_file(&archive);
        let msg = format!("[node] failed to write checksum file: {e}");
        emit_preflight_line(&app, &msg);
        return Err(msg);
    }
    emit_preflight_line(&app, "[node] verifying checksum");
    if let Err(e) = run_streaming(&app, "/usr/bin/shasum", &["-a", "256", "-c", &check_str]).await {
        let _ = std::fs::remove_file(&archive);
        let _ = std::fs::remove_file(&check_path);
        let msg = format!("[node] checksum verification failed: {e}");
        emit_preflight_line(&app, &msg);
        return Err(msg);
    }
    let _ = std::fs::remove_file(&check_path);

    if let Err(e) = std::fs::create_dir_all(&staged_dir) {
        let _ = std::fs::remove_file(&archive);
        let msg = format!("[node] failed to create staging dir: {e}");
        emit_preflight_line(&app, &msg);
        return Err(msg);
    }

    emit_preflight_line(
        &app,
        &format!("[node] extracting to {}", staged_dir.display()),
    );
    run_streaming(
        &app,
        "/usr/bin/tar",
        &[
            "-xzf",
            &archive_str,
            "-C",
            &staged_dir_str,
            "--strip-components",
            "1",
        ],
    )
    .await?;
    let _ = std::fs::remove_file(&archive);

    if !staged_bin.exists() {
        let _ = std::fs::remove_dir_all(&staged_dir);
        let msg = format!(
            "[node] install completed but node binary was not found at {}",
            staged_bin.display()
        );
        emit_preflight_line(&app, &msg);
        return Err(msg);
    }

    let output = Command::new(&staged_bin)
        .arg("--version")
        .output()
        .map_err(|e| format!("[node] failed to run staged node --version: {e}"))?;
    let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if !output.status.success() || version != MANAGED_NODE_VERSION {
        let _ = std::fs::remove_dir_all(&staged_dir);
        let msg = format!(
            "[node] staged node version check failed: expected {MANAGED_NODE_VERSION}, got '{version}'"
        );
        emit_preflight_line(&app, &msg);
        return Err(msg);
    }

    atomic_replace_dir(&staged_dir, &node_dir).map_err(|e| {
        let msg = format!("[node] failed to activate staged Node install: {e}");
        emit_preflight_line(&app, &msg);
        msg
    })?;

    Ok(format!("node installed at {}", node_bin.display()))
}

// ─────────────────────────────────────────────────────────────────────────────
// install_git
// ─────────────────────────────────────────────────────────────────────────────

/// Install git via `brew install git`.
#[cfg(not(windows))]
async fn install_git_macos(app: AppHandle) -> Result<String, String> {
    let home = home_dir_or_err(&app, "git")?;
    let toolchain_dir = managed_toolchain_dir_in(&home);
    let git_dir = managed_git_dir_in(&home);
    let git_bin = managed_git_bin_in(&home).join("git");

    if git_bin.exists() {
        emit_preflight_line(
            &app,
            &format!("[git] managed Git already present at {}", git_bin.display()),
        );
        return Ok(format!("git already installed at {}", git_bin.display()));
    }

    let arch = std::env::consts::ARCH;
    let Some(url) = managed_git_url_for(arch) else {
        let msg = format!("[git] unsupported arch '{arch}' — cannot install managed Git");
        emit_preflight_line(&app, &msg);
        return Err(msg);
    };
    let Some(expected_sha) = managed_git_sha256_for(arch) else {
        let msg = format!("[git] no pinned checksum for arch '{arch}'");
        emit_preflight_line(&app, &msg);
        return Err(msg);
    };

    if let Err(e) = std::fs::create_dir_all(&git_dir) {
        let msg = format!("[git] failed to create {}: {e}", git_dir.display());
        emit_preflight_line(&app, &msg);
        return Err(msg);
    }

    let archive = toolchain_dir.join("dugite-git.tar.gz");
    let archive_str = archive.to_string_lossy().into_owned();
    let git_dir_str = git_dir.to_string_lossy().into_owned();

    emit_preflight_line(
        &app,
        &format!(
            "[git] downloading portable Git {url} → {}",
            archive.display()
        ),
    );
    run_streaming(&app, "/usr/bin/curl", &["-fsSL", "-o", &archive_str, &url]).await?;

    // Verify SHA-256 before trusting a binary we put on PATH. `shasum -c` exits
    // non-zero on mismatch, which run_streaming surfaces as Err. The checksum
    // file uses the archive's absolute path so cwd doesn't matter.
    let check_path = toolchain_dir.join("dugite-git.sha256");
    let check_str = check_path.to_string_lossy().into_owned();
    if let Err(e) = std::fs::write(&check_path, format!("{expected_sha}  {archive_str}\n")) {
        let msg = format!("[git] failed to write checksum file: {e}");
        emit_preflight_line(&app, &msg);
        return Err(msg);
    }
    emit_preflight_line(&app, "[git] verifying checksum");
    if let Err(e) = run_streaming(&app, "/usr/bin/shasum", &["-a", "256", "-c", &check_str]).await {
        let _ = std::fs::remove_file(&archive);
        let _ = std::fs::remove_file(&check_path);
        let msg = format!("[git] checksum verification failed: {e}");
        emit_preflight_line(&app, &msg);
        return Err(msg);
    }
    let _ = std::fs::remove_file(&check_path);

    // dugite tarballs extract flat (bin/, libexec/, share/ at the root), so no
    // --strip-components — git lands at <git_dir>/bin/git.
    emit_preflight_line(&app, &format!("[git] extracting to {}", git_dir.display()));
    run_streaming(
        &app,
        "/usr/bin/tar",
        &["-xzf", &archive_str, "-C", &git_dir_str],
    )
    .await?;
    let _ = std::fs::remove_file(&archive);

    if !git_bin.exists() {
        let msg = format!(
            "[git] install completed but git binary not found at {}",
            git_bin.display()
        );
        emit_preflight_line(&app, &msg);
        return Err(msg);
    }

    emit_preflight_line(
        &app,
        &format!("[git] portable Git installed at {}", git_bin.display()),
    );
    Ok(format!("git installed at {}", git_bin.display()))
}

// ─────────────────────────────────────────────────────────────────────────────
// install_gh
// ─────────────────────────────────────────────────────────────────────────────

/// Install the GitHub CLI via `brew install gh`.
#[cfg(not(windows))]
async fn install_gh_macos(app: AppHandle) -> Result<String, String> {
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
#[cfg(not(windows))]
const YQ_BINARY_VERSION: &str = "v4.53.2";
#[cfg(not(windows))]
const YQ_BINARY_SHA256_AMD64: &str =
    "616b0a0f6a5b79d746f05a169c2b9bb40dee00c605ef165b9a1c1681bba738ac";
#[cfg(not(windows))]
const YQ_BINARY_SHA256_ARM64: &str =
    "541ba2287560df70f561955e2d7f7e1cd00cf2a15a884f6b5c87a4bfa887bc07";

#[cfg(not(windows))]
fn yq_binary_sha256_for(arch: &str) -> Option<&'static str> {
    match arch {
        "amd64" => Some(YQ_BINARY_SHA256_AMD64),
        "arm64" => Some(YQ_BINARY_SHA256_ARM64),
        _ => None,
    }
}

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
#[cfg(not(windows))]
async fn install_yq_macos(app: AppHandle) -> Result<String, String> {
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
#[cfg(not(windows))]
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
    let Some(expected_sha) = yq_binary_sha256_for(arch) else {
        let msg = format!("[yq] no pinned checksum for arch '{arch}'");
        emit_preflight_line(app, &msg);
        return Err(msg);
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
    let staged = bin_dir.join(format!(".yq.{}.tmp", Uuid::new_v4()));

    if let Err(e) = std::fs::create_dir_all(&bin_dir) {
        let msg = format!("[yq] failed to create {}: {e}", bin_dir.display());
        emit_preflight_line(app, &msg);
        return Err(msg);
    }

    emit_preflight_line(
        app,
        &format!("[yq] downloading {url} → {}", staged.display()),
    );

    let staged_str = staged.to_string_lossy().into_owned();

    // curl flags: -f fails on HTTP error (so a 404 surfaces instead of
    // writing an HTML error page to disk and chmod'ing it +x), -sS keeps
    // the progress bar quiet but still emits errors to stderr (which
    // `run_streaming` captures), -L follows redirects (GitHub redirects
    // release assets to S3).
    run_streaming(app, "curl", &["-fsSL", "-o", &staged_str, &url]).await?;

    let check_path = bin_dir.join(format!(".yq-{YQ_BINARY_VERSION}.sha256"));
    let check_str = check_path.to_string_lossy().into_owned();
    if let Err(e) = std::fs::write(&check_path, format!("{expected_sha}  {staged_str}\n")) {
        let _ = std::fs::remove_file(&staged);
        let msg = format!("[yq] failed to write checksum file: {e}");
        emit_preflight_line(app, &msg);
        return Err(msg);
    }
    emit_preflight_line(app, "[yq] verifying checksum");
    if let Err(e) = run_streaming(app, "/usr/bin/shasum", &["-a", "256", "-c", &check_str]).await {
        let _ = std::fs::remove_file(&staged);
        let _ = std::fs::remove_file(&check_path);
        let msg = format!("[yq] checksum verification failed: {e}");
        emit_preflight_line(app, &msg);
        return Err(msg);
    }
    let _ = std::fs::remove_file(&check_path);

    run_streaming(app, "chmod", &["+x", &staged_str]).await?;

    let output = Command::new(&staged)
        .arg("--version")
        .output()
        .map_err(|e| format!("[yq] failed to run staged yq --version: {e}"))?;
    let combined = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    if !output.status.success() || !combined.contains(YQ_BINARY_VERSION) {
        let _ = std::fs::remove_file(&staged);
        let msg = format!(
            "[yq] staged yq version check failed: expected {YQ_BINARY_VERSION}, got '{}'",
            combined.lines().next().unwrap_or("").trim()
        );
        emit_preflight_line(app, &msg);
        return Err(msg);
    }

    atomic_replace_file(&staged, &target).map_err(|e| {
        let msg = format!("[yq] failed to activate staged binary: {e}");
        emit_preflight_line(app, &msg);
        msg
    })?;

    Ok(format!("yq installed at {}", target.display()))
}

// ─────────────────────────────────────────────────────────────────────────────
// install_claude_code
// ─────────────────────────────────────────────────────────────────────────────

/// Install the Claude Code CLI via `npm install -g @anthropic-ai/claude-code`.
///
/// Errors if npm is not available.
#[cfg(not(windows))]
async fn install_claude_code_macos(app: AppHandle) -> Result<String, String> {
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
#[cfg(not(windows))]
async fn install_qmd_macos(app: AppHandle) -> Result<String, String> {
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

// ─────────────────────────────────────────────────────────────────────────────
// install_hq_cli
// ─────────────────────────────────────────────────────────────────────────────

/// Install the HQ CLI via `npm install -g @indigoai-us/hq-cli`.
///
/// Errors if npm is not available.
#[cfg(not(windows))]
async fn install_hq_cli_macos(app: AppHandle) -> Result<String, String> {
    let prefix = npm_global_prefix_arg(&app, "hq")?;
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
        &["install", "-g", "--prefix", &prefix, "@indigoai-us/hq-cli"],
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

// ─────────────────────────────────────────────────────────────────────────────
// Shared install command wrappers
// ─────────────────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn install_node(app: AppHandle) -> Result<String, String> {
    #[cfg(not(windows))]
    {
        install_node_macos(app).await
    }
    #[cfg(windows)]
    {
        install_node_windows(app).await
    }
}

#[tauri::command]
pub async fn install_git(app: AppHandle) -> Result<String, String> {
    #[cfg(not(windows))]
    {
        install_git_macos(app).await
    }
    #[cfg(windows)]
    {
        install_git_windows(app).await
    }
}

#[tauri::command]
pub async fn install_gh(app: AppHandle) -> Result<String, String> {
    #[cfg(not(windows))]
    {
        install_gh_macos(app).await
    }
    #[cfg(windows)]
    {
        install_gh_windows(app).await
    }
}

#[tauri::command]
pub async fn install_yq(app: AppHandle) -> Result<String, String> {
    #[cfg(not(windows))]
    {
        install_yq_macos(app).await
    }
    #[cfg(windows)]
    {
        install_yq_windows(app).await
    }
}

#[tauri::command]
pub async fn install_claude_code(app: AppHandle) -> Result<String, String> {
    #[cfg(not(windows))]
    {
        install_claude_code_macos(app).await
    }
    #[cfg(windows)]
    {
        install_claude_code_windows(app).await
    }
}

#[tauri::command]
pub async fn install_qmd(app: AppHandle) -> Result<String, String> {
    #[cfg(not(windows))]
    {
        install_qmd_macos(app).await
    }
    #[cfg(windows)]
    {
        install_qmd_windows(app).await
    }
}

#[tauri::command]
pub async fn install_hq_cli(app: AppHandle) -> Result<String, String> {
    #[cfg(not(windows))]
    {
        install_hq_cli_macos(app).await
    }
    #[cfg(windows)]
    {
        install_hq_cli_windows(app).await
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Windows dependency implementation
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
#[cfg(windows)]
const WINDOWS_MANAGED_NODE_VERSION: &str = "v22.12.0";
#[cfg(windows)]
const WINDOWS_MANAGED_NODE_SHA256_X64: &str =
    "2b8f2256382f97ad51e29ff71f702961af466c4616393f767455501e6aece9b8";
#[cfg(windows)]
const WINDOWS_MANAGED_NODE_SHA256_ARM64: &str =
    "17401720af48976e3f67c41e8968a135fb49ca1f88103a92e0e8c70605763854";
#[cfg(windows)]
const WINDOWS_YQ_VERSION: &str = "v4.53.2";
#[cfg(windows)]
const WINDOWS_YQ_SHA256_AMD64: &str =
    "2aee32f1de46a20672f48c25df3018839798bd509143f2ce05fdab1550ff5592";
#[cfg(windows)]
const WINDOWS_YQ_SHA256_ARM64: &str =
    "448208550332ca33ef816e4cee49fc1e79987b8a08a451c6ae529703c8cfc8a9";
#[cfg(windows)]
const RSYNC_BUNDLE_SHA256: &str =
    "0e1d90ab60c2fd6c24debe6b59bd4b23ea65009a408976f94b916dcad8332f1d";

#[cfg(windows)]
fn debug_log(msg: &str) {
    if is_deps_debug_enabled() {
        eprintln!("[hq-deps] {msg}");
    }
}

#[cfg(windows)]
#[derive(Debug, Clone)]
struct DownloadedAsset {
    status: u16,
    bytes: Vec<u8>,
}

#[cfg(windows)]
fn require_http_success(status: u16, label: &str) -> Result<(), String> {
    if (200..=299).contains(&status) {
        Ok(())
    } else {
        Err(format!("{label} download returned HTTP status {status}"))
    }
}

#[cfg(windows)]
fn fetch_asset_with<F>(url: &str, label: &str, fetch: F) -> Result<Vec<u8>, String>
where
    F: FnOnce(&str) -> Result<DownloadedAsset, String>,
{
    let asset = fetch(url)?;
    require_http_success(asset.status, label)?;
    Ok(asset.bytes)
}

#[cfg(windows)]
fn download_bytes_checked(url: &str, label: &str) -> Result<Vec<u8>, String> {
    fetch_asset_with(url, label, |url| {
        let response = reqwest::blocking::get(url)
            .map_err(|e| format!("Failed to fetch {label}: {e}"))?
            .error_for_status()
            .map_err(|e| format!("{label} download returned error: {e}"))?;
        let status = response.status().as_u16();
        let bytes = response
            .bytes()
            .map_err(|e| format!("Failed to read {label} response: {e}"))?
            .to_vec();
        Ok(DownloadedAsset { status, bytes })
    })
}

#[cfg(windows)]
fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    format!("{:x}", Sha256::digest(bytes))
}

#[cfg(windows)]
fn verify_sha256_bytes(label: &str, bytes: &[u8], expected: &str) -> Result<(), String> {
    let actual = sha256_hex(bytes);
    if actual.eq_ignore_ascii_case(expected) {
        Ok(())
    } else {
        Err(format!(
            "{label} checksum mismatch: expected {expected}, got {actual}"
        ))
    }
}

/// Where HQ stores its managed toolchain on Windows. Per-user, non-roaming
/// (LOCALAPPDATA), so a multi-hundred-MB Node install doesn't get pulled
/// across roaming profile sync.
#[cfg(windows)]
pub fn managed_toolchain_dir() -> PathBuf {
    local_app_data().join("IndigoHQ").join("toolchain")
}

#[cfg(windows)]
fn local_app_data() -> PathBuf {
    std::env::var("LOCALAPPDATA")
        .ok()
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            dirs::home_dir()
                .unwrap_or_else(|| PathBuf::from("."))
                .join("AppData")
                .join("Local")
        })
}

#[cfg(windows)]
fn user_profile() -> PathBuf {
    std::env::var("USERPROFILE")
        .ok()
        .map(PathBuf::from)
        .unwrap_or_else(|| dirs::home_dir().unwrap_or_else(|| PathBuf::from(".")))
}

#[cfg(windows)]
fn program_files() -> PathBuf {
    std::env::var("ProgramFiles")
        .ok()
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("C:\\Program Files"))
}

#[cfg(windows)]
fn system_root() -> PathBuf {
    std::env::var("SystemRoot")
        .ok()
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("C:\\Windows"))
}

#[cfg(windows)]
fn managed_node_dir() -> PathBuf {
    managed_toolchain_dir().join("node")
}

#[cfg(windows)]
fn managed_node_bin() -> PathBuf {
    managed_node_dir()
}

#[cfg(windows)]
fn managed_npm_prefix() -> PathBuf {
    managed_toolchain_dir().join("npm-prefix")
}

#[cfg(windows)]
fn managed_npm_bin() -> PathBuf {
    managed_npm_prefix()
}

#[cfg(windows)]
fn latest_claude_code_dir() -> Option<PathBuf> {
    let roaming = std::env::var("APPDATA").ok()?;
    let base = PathBuf::from(roaming).join("Claude").join("claude-code");
    let mut versions: Vec<PathBuf> = std::fs::read_dir(&base)
        .ok()?
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
        .map(|e| e.path())
        .filter(|p| p.join("claude.exe").exists())
        .collect();
    if versions.is_empty() {
        return None;
    }
    versions.sort();
    versions.pop()
}

/// PATH used when spawning install subprocesses. Composes Windows-standard
/// install locations so install scripts can find each other before the
/// user's PATH is refreshed via WM_SETTINGCHANGE.
#[cfg(windows)]
pub fn extended_search_path() -> String {
    let mut dirs: Vec<String> = vec![
        managed_node_bin().to_string_lossy().into_owned(),
        managed_npm_bin().to_string_lossy().into_owned(),
        managed_toolchain_dir()
            .join("bin")
            .to_string_lossy()
            .into_owned(),
        program_files()
            .join("Git")
            .join("bin")
            .to_string_lossy()
            .into_owned(),
        program_files()
            .join("Git")
            .join("usr")
            .join("bin")
            .to_string_lossy()
            .into_owned(),
        program_files()
            .join("Git")
            .join("cmd")
            .to_string_lossy()
            .into_owned(),
        local_app_data()
            .join("Microsoft")
            .join("WindowsApps")
            .to_string_lossy()
            .into_owned(),
        local_app_data()
            .join("Microsoft")
            .join("WinGet")
            .join("Links")
            .to_string_lossy()
            .into_owned(),
        user_profile()
            .join("scoop")
            .join("shims")
            .to_string_lossy()
            .into_owned(),
        program_files()
            .join("GitHub CLI")
            .to_string_lossy()
            .into_owned(),
        system_root()
            .join("System32")
            .to_string_lossy()
            .into_owned(),
        system_root().to_string_lossy().into_owned(),
    ];

    if let Some(latest) = latest_claude_code_dir() {
        dirs.push(latest.to_string_lossy().into_owned());
    }

    if let Ok(existing) = std::env::var("PATH") {
        dirs.push(existing);
    }

    let joined = dirs.join(";");
    debug_log(&format!(
        "extended_search_path composed: {} entries, {} bytes",
        dirs.len(),
        joined.len()
    ));
    joined
}

/// Append `new_dir` to the user's persistent PATH (HKCU\Environment\Path)
/// and broadcast WM_SETTINGCHANGE so new shells pick it up without logout.
#[cfg(windows)]
#[derive(Clone)]
struct UserPathValue {
    value: String,
    value_type: winreg::enums::RegType,
}

#[cfg(windows)]
fn decode_registry_string(raw: &RegValue, name: &str) -> Result<String, String> {
    if raw.vtype != REG_SZ && raw.vtype != REG_EXPAND_SZ {
        return Err(format!(
            "HKCU\\Environment\\{name} has unsupported registry type {:?}",
            raw.vtype
        ));
    }
    if !raw.bytes.len().is_multiple_of(2) {
        return Err(format!(
            "HKCU\\Environment\\{name} has invalid UTF-16 byte length {}",
            raw.bytes.len()
        ));
    }

    let mut units = Vec::with_capacity(raw.bytes.len() / 2);
    for chunk in raw.bytes.chunks_exact(2) {
        units.push(u16::from_le_bytes([chunk[0], chunk[1]]));
    }
    while units.last() == Some(&0) {
        units.pop();
    }
    String::from_utf16(&units)
        .map_err(|e| format!("HKCU\\Environment\\{name} is not valid UTF-16: {e}"))
}

#[cfg(windows)]
fn encode_registry_string(value: &str, value_type: winreg::enums::RegType) -> RegValue {
    let mut bytes = Vec::with_capacity((value.len() + 1) * 2);
    for unit in value.encode_utf16().chain(std::iter::once(0)) {
        bytes.extend_from_slice(&unit.to_le_bytes());
    }
    RegValue {
        bytes,
        vtype: value_type,
    }
}

#[cfg(windows)]
fn read_user_path_value(env: &RegKey) -> Result<UserPathValue, String> {
    match env.get_raw_value("Path") {
        Ok(raw) => Ok(UserPathValue {
            value: decode_registry_string(&raw, "Path")?,
            value_type: raw.vtype,
        }),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(UserPathValue {
            value: String::new(),
            value_type: REG_EXPAND_SZ,
        }),
        Err(e) => Err(format!("HKCU\\Environment\\Path read failed: {e}")),
    }
}

#[cfg(windows)]
fn write_user_path_value(env: &RegKey, value: &UserPathValue) -> Result<(), String> {
    env.set_raw_value(
        "Path",
        &encode_registry_string(&value.value, value.value_type.clone()),
    )
    .map_err(|e| format!("HKCU\\Environment\\Path write failed: {e}"))
}

#[cfg(windows)]
pub fn append_user_path(new_dir: &Path) -> Result<(), String> {
    let dir_str = new_dir.to_string_lossy().to_string();

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let env = hkcu
        .open_subkey_with_flags("Environment", KEY_READ | KEY_SET_VALUE)
        .map_err(|e| format!("HKCU\\Environment open failed: {e}"))?;

    let mut current_value = read_user_path_value(&env)?;
    let current = current_value.value.clone();

    let already_present = current
        .split(';')
        .any(|entry| entry.eq_ignore_ascii_case(&dir_str));
    if already_present {
        debug_log(&format!(
            "append_user_path: '{dir_str}' already on PATH, skipping"
        ));
        return Ok(());
    }

    let updated = if current.is_empty() {
        dir_str.clone()
    } else if current.ends_with(';') {
        format!("{current}{dir_str}")
    } else {
        format!("{current};{dir_str}")
    };

    current_value.value = updated;
    write_user_path_value(&env, &current_value)?;

    broadcast_environment_change();
    debug_log(&format!(
        "append_user_path: added '{dir_str}', broadcast sent"
    ));
    Ok(())
}

/// Remove `dir` from the user's persistent PATH. Idempotent.
#[cfg(windows)]
pub fn remove_user_path(dir: &Path) -> Result<(), String> {
    let dir_str = dir.to_string_lossy().to_string();

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let env = hkcu
        .open_subkey_with_flags("Environment", KEY_READ | KEY_SET_VALUE)
        .map_err(|e| format!("HKCU\\Environment open failed: {e}"))?;

    let mut current_value = read_user_path_value(&env)?;
    let current = current_value.value.clone();
    let parts: Vec<&str> = current
        .split(';')
        .filter(|entry| !entry.eq_ignore_ascii_case(&dir_str))
        .collect();
    let updated = parts.join(";");

    if updated == current {
        return Ok(());
    }

    current_value.value = updated;
    write_user_path_value(&env, &current_value)?;
    broadcast_environment_change();
    Ok(())
}

#[cfg(windows)]
fn broadcast_environment_change() {
    let msg: Vec<u16> = "Environment\0".encode_utf16().collect();
    let mut result: usize = 0;
    unsafe {
        SendMessageTimeoutW(
            HWND_BROADCAST as HWND,
            WM_SETTINGCHANGE,
            0,
            msg.as_ptr() as isize,
            SMTO_ABORTIFHUNG,
            5_000,
            &mut result,
        );
    }
}

#[cfg(windows)]
pub fn check_dep_impl(tool: &str, search_path: Option<&str>) -> DepStatus {
    let path_str = search_path
        .map(String::from)
        .unwrap_or_else(extended_search_path);

    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let found = which::which_in(tool, Some(&path_str), &cwd).ok();

    match found {
        Some(path) => {
            let output = Command::new(&path)
                .arg("--version")
                .env("PATH", &path_str)
                .creation_flags(CREATE_NO_WINDOW)
                .output()
                .ok();

            let (functional, version) = match output {
                Some(o) if o.status.success() => (
                    true,
                    Some(
                        String::from_utf8_lossy(&o.stdout)
                            .lines()
                            .next()
                            .unwrap_or("")
                            .trim()
                            .to_string(),
                    ),
                ),
                Some(_) => (false, None),
                None => (false, None),
            };

            if !functional {
                return DepStatus {
                    installed: false,
                    version: None,
                    path: Some(path),
                };
            }

            DepStatus {
                installed: true,
                version,
                path: Some(path),
            }
        }
        None => DepStatus {
            installed: false,
            version: None,
            path: None,
        },
    }
}

#[cfg(windows)]
pub fn check_dep_in(tool: &str, path_dirs: &str) -> DepStatus {
    check_dep_impl(tool, Some(path_dirs))
}

#[cfg(windows)]
#[derive(Debug, Clone)]
pub enum PackageManager {
    Winget,
    Scoop,
    Managed,
}

#[cfg(windows)]
fn detect_package_manager() -> PackageManager {
    let path = extended_search_path();
    if which::which_in(
        "winget",
        Some(&path),
        std::env::current_dir().unwrap_or_default(),
    )
    .is_ok()
    {
        return PackageManager::Winget;
    }
    if which::which_in(
        "scoop",
        Some(&path),
        std::env::current_dir().unwrap_or_default(),
    )
    .is_ok()
    {
        return PackageManager::Scoop;
    }
    PackageManager::Managed
}

#[cfg(windows)]
async fn run_streaming(app: &AppHandle, program: &str, args: &[&str]) -> Result<String, String> {
    let handle_id = Uuid::new_v4().to_string();
    register_cancel_handle(handle_id.clone());

    let search_path = extended_search_path();
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let resolved = match which::which_in(program, Some(&search_path), &cwd) {
        Ok(path) => path,
        Err(_) => {
            deregister_handle(&handle_id);
            return Err(format!("'{}' not found on PATH", program));
        }
    };

    let job = match create_job_object() {
        Ok(job) => Arc::new(job),
        Err(e) => {
            deregister_handle(&handle_id);
            return Err(e);
        }
    };

    let mut command = Command::new(&resolved);
    command
        .args(args)
        .env("PATH", &search_path)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .creation_flags(CREATE_NO_WINDOW);

    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(e) => {
            deregister_handle(&handle_id);
            return Err(format!("Failed to spawn '{}': {}", program, e));
        }
    };

    if let Err(e) = assign_process_to_job(job.0, child.as_raw_handle() as HANDLE) {
        let kill_result = child.kill().map_err(|kill_err| {
            format!("failed to kill untracked child after job assignment failure: {kill_err}")
        });
        let wait_result = child.wait().map_err(|wait_err| {
            format!("failed to wait untracked child after job assignment failure: {wait_err}")
        });
        deregister_handle(&handle_id);
        if let Err(kill_err) = kill_result {
            return Err(format!("{e}; {kill_err}"));
        }
        if let Err(wait_err) = wait_result {
            return Err(format!("{e}; {wait_err}"));
        }
        return Err(e);
    }
    register_job_handle(&handle_id, job.clone());
    if is_cancelled(&handle_id) {
        if let Err(e) = terminate_process_tree(&handle_id) {
            record_kill_error(&handle_id, e);
        }
    }

    let stdout = match child.stdout.take() {
        Some(stdout) => stdout,
        None => {
            deregister_handle(&handle_id);
            return Err("no stdout".to_string());
        }
    };
    let stderr = match child.stderr.take() {
        Some(stderr) => stderr,
        None => {
            deregister_handle(&handle_id);
            return Err("no stderr".to_string());
        }
    };

    enum ReaderMsg {
        Stdout(String),
        Stderr,
        Done {
            stream: &'static str,
            err: Option<String>,
        },
    }

    let stderr_lines: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let (tx, rx) = mpsc::channel::<ReaderMsg>();
    let stdout_thread = {
        let tx = tx.clone();
        std::thread::spawn(move || {
            let mut err = None;
            for line_result in BufReader::new(stdout).lines() {
                match line_result {
                    Ok(line) => {
                        if tx.send(ReaderMsg::Stdout(line)).is_err() {
                            return;
                        }
                    }
                    Err(e) => {
                        err = Some(e.to_string());
                        break;
                    }
                }
            }
            let _ = tx.send(ReaderMsg::Done {
                stream: "stdout",
                err,
            });
        })
    };
    let stderr_thread = {
        let app = app.clone();
        let handle_id = handle_id.clone();
        let stderr_lines = Arc::clone(&stderr_lines);
        let tx = tx.clone();
        std::thread::spawn(move || {
            let mut err = None;
            for line_result in BufReader::new(stderr).lines() {
                match line_result {
                    Ok(line) => {
                        stderr_lines.lock().unwrap().push(line.clone());
                        let _ = app.emit(
                            "install:progress",
                            InstallProgress {
                                handle: handle_id.clone(),
                                line: line.clone(),
                                finished: false,
                                error: None,
                            },
                        );
                        if tx.send(ReaderMsg::Stderr).is_err() {
                            return;
                        }
                    }
                    Err(e) => {
                        err = Some(e.to_string());
                        break;
                    }
                }
            }
            let _ = tx.send(ReaderMsg::Done {
                stream: "stderr",
                err,
            });
        })
    };
    drop(tx);

    let mut done_count = 0;
    let mut first_stream_err: Option<String> = None;
    let mut status = None;
    let mut cancel_signal_sent = false;

    loop {
        match rx.recv_timeout(Duration::from_millis(100)) {
            Ok(ReaderMsg::Stdout(line)) => {
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
            Ok(ReaderMsg::Stderr) => {}
            Ok(ReaderMsg::Done { stream, err }) => {
                if let Some(e) = err {
                    if first_stream_err.is_none() {
                        first_stream_err = Some(format!("{stream}: {e}"));
                    }
                }
                done_count += 1;
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }

        if is_cancelled(&handle_id) && !cancel_signal_sent {
            if let Err(e) = terminate_process_tree(&handle_id) {
                record_kill_error(&handle_id, e);
            }
            cancel_signal_sent = true;
        }

        if status.is_none() {
            status = child.try_wait().map_err(|e| e.to_string())?;
        }
        if status.is_some() && done_count >= 2 {
            break;
        }
        if done_count >= 2 && status.is_none() {
            status = Some(child.wait().map_err(|e| e.to_string())?);
            break;
        }
    }

    let status = match status {
        Some(status) => status,
        None => child.wait().map_err(|e| e.to_string())?,
    };

    let stdout_join = stdout_thread
        .join()
        .map_err(|_| "stdout reader thread panicked".to_string());
    let stderr_join = stderr_thread
        .join()
        .map_err(|_| "stderr reader thread panicked".to_string());

    let was_cancelled = is_cancelled(&handle_id);
    let kill_error = take_kill_error(&handle_id);
    deregister_handle(&handle_id);

    if let Err(e) = stdout_join.and(stderr_join) {
        let _ = app.emit(
            "install:progress",
            InstallProgress {
                handle: handle_id.clone(),
                line: String::new(),
                finished: true,
                error: Some(e.clone()),
            },
        );
        return Err(e);
    }

    if was_cancelled {
        let msg = match kill_error {
            Some(e) => format!("Cancelled by user; {e}"),
            None => "Cancelled by user".to_string(),
        };
        let _ = app.emit(
            "install:progress",
            InstallProgress {
                handle: handle_id.clone(),
                line: String::new(),
                finished: true,
                error: Some(msg.clone()),
            },
        );
        return Err(msg);
    }

    if let Some(err) = first_stream_err {
        let _ = app.emit(
            "install:progress",
            InstallProgress {
                handle: handle_id.clone(),
                line: String::new(),
                finished: true,
                error: Some(err.clone()),
            },
        );
        return Err(err);
    }

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

#[cfg(windows)]
fn emit_progress(app: &AppHandle, msg: &str) {
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

#[cfg(windows)]
async fn winget_install(app: &AppHandle, id: &str) -> Result<String, String> {
    run_streaming(
        app,
        "winget",
        &[
            "install",
            "--id",
            id,
            "--silent",
            "--accept-source-agreements",
            "--accept-package-agreements",
        ],
    )
    .await
}

#[cfg(windows)]
async fn scoop_install(app: &AppHandle, name: &str) -> Result<String, String> {
    run_streaming(app, "scoop", &["install", name]).await
}

#[cfg(windows)]
async fn install_node_windows(app: AppHandle) -> Result<String, String> {
    emit_progress(&app, "Detecting package manager...");
    let pm = detect_package_manager();
    match pm {
        PackageManager::Winget => {
            emit_progress(&app, "Installing Node.js LTS via winget...");
            winget_install(&app, "OpenJS.NodeJS.LTS").await?;
            append_user_path_for_node()?;
            Ok("node installed via winget".to_string())
        }
        PackageManager::Scoop => {
            emit_progress(&app, "Installing Node.js LTS via scoop...");
            scoop_install(&app, "nodejs-lts").await?;
            append_user_path_for_node()?;
            Ok("node installed via scoop".to_string())
        }
        PackageManager::Managed => {
            emit_progress(
                &app,
                "No package manager found - downloading portable Node...",
            );
            install_managed_node(&app).await
        }
    }
}

#[cfg(windows)]
fn append_user_path_for_node() -> Result<(), String> {
    append_user_path(&local_app_data().join("Microsoft").join("WindowsApps"))?;
    append_user_path(&program_files().join("nodejs"))?;
    Ok(())
}

#[cfg(windows)]
fn windows_managed_node_sha256_for(arch: &str) -> Option<&'static str> {
    match arch {
        "x64" => Some(WINDOWS_MANAGED_NODE_SHA256_X64),
        "arm64" => Some(WINDOWS_MANAGED_NODE_SHA256_ARM64),
        _ => None,
    }
}

#[cfg(windows)]
fn zip_entry_relative_to_root(
    enclosed: &Path,
    expected_root: &str,
    raw_name: &str,
) -> Result<Option<PathBuf>, String> {
    let mut comps = enclosed.components();
    let Some(first) = comps.next() else {
        return Ok(None);
    };
    match first {
        std::path::Component::Normal(root) if root == std::ffi::OsStr::new(expected_root) => {}
        _ => {
            return Err(format!(
                "zip entry outside expected root '{expected_root}': {raw_name}"
            ))
        }
    }

    let mut rel = PathBuf::new();
    for comp in comps {
        match comp {
            std::path::Component::Normal(part) => rel.push(part),
            std::path::Component::CurDir => {}
            std::path::Component::Prefix(_)
            | std::path::Component::RootDir
            | std::path::Component::ParentDir => {
                return Err(format!("zip entry has unsafe component: {raw_name}"));
            }
        }
    }

    if rel.as_os_str().is_empty() {
        Ok(None)
    } else {
        Ok(Some(rel))
    }
}

#[cfg(windows)]
fn zip_raw_name_has_unsafe_component(raw_name: &str) -> bool {
    Path::new(raw_name).components().any(|component| {
        matches!(
            component,
            std::path::Component::Prefix(_)
                | std::path::Component::RootDir
                | std::path::Component::ParentDir
        )
    })
}

#[cfg(windows)]
fn validate_managed_node_dir(node_dir: &Path) -> Result<(), String> {
    for leaf in ["node.exe", "npm.cmd", "npx.cmd"] {
        let path = node_dir.join(leaf);
        if !path.is_file() {
            return Err(format!(
                "managed Node missing required file {}",
                path.display()
            ));
        }
    }
    Ok(())
}

#[cfg(windows)]
fn extract_managed_node_zip(
    bytes: &[u8],
    version: &str,
    arch: &str,
    staged_node_dir: &Path,
) -> Result<(), String> {
    let cursor = std::io::Cursor::new(bytes);
    let mut archive =
        zip::ZipArchive::new(cursor).map_err(|e| format!("Failed to open Node zip: {e}"))?;

    let archive_root = format!("node-{version}-win-{arch}");
    std::fs::create_dir_all(staged_node_dir)
        .map_err(|e| format!("mkdir {}: {e}", staged_node_dir.display()))?;

    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| format!("node zip entry {i}: {e}"))?;
        let raw_name = entry.name().to_string();
        if zip_raw_name_has_unsafe_component(&raw_name) {
            return Err(format!("node zip entry has unsafe path: {raw_name}"));
        }
        let enclosed = entry
            .enclosed_name()
            .ok_or_else(|| format!("node zip entry has unsafe path: {raw_name}"))?
            .to_path_buf();
        let Some(rel) = zip_entry_relative_to_root(&enclosed, &archive_root, &raw_name)? else {
            continue;
        };
        let out_path = staged_node_dir.join(&rel);
        if !out_path.starts_with(staged_node_dir) {
            return Err(format!("node zip entry escapes staging dir: {raw_name}"));
        }
        if entry.is_dir() {
            std::fs::create_dir_all(&out_path)
                .map_err(|e| format!("mkdir {}: {e}", out_path.display()))?;
            continue;
        }
        if let Some(parent) = out_path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("mkdir parent {}: {e}", parent.display()))?;
        }
        let mut out =
            std::fs::File::create(&out_path).map_err(|e| format!("create {out_path:?}: {e}"))?;
        std::io::copy(&mut entry, &mut out).map_err(|e| format!("extract {out_path:?}: {e}"))?;
    }

    validate_managed_node_dir(staged_node_dir)
}

#[cfg(windows)]
fn ensure_node_version(node_exe: &Path, expected_version: &str) -> Result<(), String> {
    let output = Command::new(node_exe)
        .arg("--version")
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| format!("failed to run {} --version: {e}", node_exe.display()))?;
    let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if output.status.success() && version == expected_version {
        Ok(())
    } else {
        Err(format!(
            "managed Node version check failed: expected {expected_version}, got '{version}'"
        ))
    }
}

#[cfg(windows)]
async fn install_managed_node(app: &AppHandle) -> Result<String, String> {
    let arch = managed_node_arch().ok_or_else(|| {
        format!(
            "Unsupported architecture for managed Node fallback: {}",
            std::env::consts::ARCH
        )
    })?;
    let version = WINDOWS_MANAGED_NODE_VERSION;
    let expected_sha = windows_managed_node_sha256_for(arch)
        .ok_or_else(|| format!("No pinned Node checksum for Windows arch {arch}"))?;
    let url = format!("https://nodejs.org/dist/{version}/node-{version}-win-{arch}.zip");

    emit_progress(app, &format!("Downloading {url}"));
    let url_for_dl = url.clone();
    let bytes =
        tokio::task::spawn_blocking(move || download_bytes_checked(&url_for_dl, "Node zip"))
            .await
            .map_err(|e| format!("node download task join failed: {e}"))??;
    emit_progress(app, &format!("Downloaded {} bytes", bytes.len()));
    verify_sha256_bytes("Node zip", &bytes, expected_sha)?;

    let target = managed_toolchain_dir();
    std::fs::create_dir_all(&target).map_err(|e| format!("Failed to mkdir {target:?}: {e}"))?;

    let node_dir = managed_node_dir();
    let staged_node_dir = target.join(format!(".node-install-{}", Uuid::new_v4()));
    emit_progress(app, &format!("Extracting Node into {staged_node_dir:?}..."));
    if let Err(e) = extract_managed_node_zip(&bytes, version, arch, &staged_node_dir) {
        let _ = std::fs::remove_dir_all(&staged_node_dir);
        return Err(e);
    }
    if let Err(e) = ensure_node_version(&staged_node_dir.join("node.exe"), version) {
        let _ = std::fs::remove_dir_all(&staged_node_dir);
        return Err(e);
    }
    atomic_replace_dir(&staged_node_dir, &node_dir)?;

    append_user_path(&node_dir)?;
    append_user_path(&managed_npm_bin())?;

    Ok(format!("Managed Node installed at {node_dir:?}"))
}

#[cfg(windows)]
fn managed_node_arch() -> Option<&'static str> {
    match std::env::consts::ARCH {
        "x86_64" => Some("x64"),
        "aarch64" => Some("arm64"),
        _ => None,
    }
}

#[cfg(windows)]
#[tauri::command]
pub async fn install_pnpm(app: AppHandle) -> Result<String, String> {
    emit_progress(&app, "Installing pnpm via npm...");

    let result = run_streaming(
        &app,
        "npm",
        &[
            "install",
            "-g",
            "--prefix",
            &managed_npm_prefix().to_string_lossy(),
            "pnpm@9",
        ],
    )
    .await?;

    append_user_path(&managed_npm_bin())?;
    Ok(result)
}

#[cfg(windows)]
async fn install_git_windows(app: AppHandle) -> Result<String, String> {
    emit_progress(&app, "Detecting package manager for Git install...");
    let pm = detect_package_manager();
    match pm {
        PackageManager::Winget => {
            emit_progress(&app, "Installing Git via winget...");
            winget_install(&app, "Git.Git").await?;
            append_user_path(&program_files().join("Git").join("cmd"))?;
            Ok("git installed via winget".to_string())
        }
        PackageManager::Scoop => {
            emit_progress(&app, "Installing Git via scoop...");
            scoop_install(&app, "git").await?;
            append_user_path(&user_profile().join("scoop").join("shims"))?;
            Ok("git installed via scoop".to_string())
        }
        PackageManager::Managed => Err(
            "Git is optional. No package manager available - install Git for Windows from https://git-scm.com to enable HQ git features."
                .to_string(),
        ),
    }
}

#[cfg(windows)]
async fn install_gh_windows(app: AppHandle) -> Result<String, String> {
    emit_progress(&app, "Detecting package manager for GitHub CLI install...");
    let pm = detect_package_manager();
    match pm {
        PackageManager::Winget => {
            emit_progress(&app, "Installing GitHub CLI via winget...");
            winget_install(&app, "GitHub.cli").await?;
            append_user_path(&program_files().join("GitHub CLI"))?;
            Ok("gh installed via winget".to_string())
        }
        PackageManager::Scoop => {
            emit_progress(&app, "Installing GitHub CLI via scoop...");
            scoop_install(&app, "gh").await?;
            append_user_path(&user_profile().join("scoop").join("shims"))?;
            Ok("gh installed via scoop".to_string())
        }
        PackageManager::Managed => Err(
            "GitHub CLI is required for HQ template cloning. Install from https://cli.github.com or run `winget install --id GitHub.cli` once winget is available."
                .to_string(),
        ),
    }
}

#[cfg(windows)]
async fn install_yq_windows(app: AppHandle) -> Result<String, String> {
    let (arch, expected_sha) = match std::env::consts::ARCH {
        "x86_64" => ("amd64", WINDOWS_YQ_SHA256_AMD64),
        "aarch64" => ("arm64", WINDOWS_YQ_SHA256_ARM64),
        _ => {
            return Err(format!(
                "Unsupported architecture for yq install: {}",
                std::env::consts::ARCH
            ))
        }
    };
    let url = format!(
        "https://github.com/mikefarah/yq/releases/download/{WINDOWS_YQ_VERSION}/yq_windows_{arch}.exe"
    );

    emit_progress(&app, &format!("Downloading {url}..."));
    let url_owned = url.clone();
    let bytes = tokio::task::spawn_blocking(move || download_bytes_checked(&url_owned, "yq"))
        .await
        .map_err(|e| format!("yq download task join failed: {e}"))??;

    let bin_dir = managed_toolchain_dir().join("bin");
    let out = bin_dir.join("yq.exe");
    install_yq_windows_from_bytes(&bytes, expected_sha, &out, |staged| {
        ensure_yq_version(staged, WINDOWS_YQ_VERSION)
    })?;

    append_user_path(&bin_dir)?;
    Ok(format!("yq installed at {out:?}"))
}

#[cfg(windows)]
fn ensure_yq_version(yq_exe: &Path, expected_version: &str) -> Result<(), String> {
    let output = Command::new(yq_exe)
        .arg("--version")
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| format!("failed to run {} --version: {e}", yq_exe.display()))?;
    let combined = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    if output.status.success() && combined.contains(expected_version) {
        Ok(())
    } else {
        Err(format!(
            "yq version check failed: expected {expected_version}, got '{}'",
            combined.lines().next().unwrap_or("").trim()
        ))
    }
}

#[cfg(windows)]
fn install_yq_windows_from_bytes<F>(
    bytes: &[u8],
    expected_sha: &str,
    target: &Path,
    version_check: F,
) -> Result<(), String>
where
    F: FnOnce(&Path) -> Result<(), String>,
{
    verify_sha256_bytes("yq", bytes, expected_sha)?;
    let parent = target
        .parent()
        .ok_or_else(|| format!("yq target has no parent: {}", target.display()))?;
    std::fs::create_dir_all(parent).map_err(|e| format!("Failed to mkdir {parent:?}: {e}"))?;
    let staged = parent.join(format!(".yq.{}.tmp", Uuid::new_v4()));
    std::fs::write(&staged, bytes).map_err(|e| format!("Failed to write staged yq: {e}"))?;
    if let Err(e) = version_check(&staged) {
        let _ = std::fs::remove_file(&staged);
        return Err(e);
    }
    atomic_replace_file(&staged, target)
}

#[cfg(windows)]
async fn install_claude_code_windows(app: AppHandle) -> Result<String, String> {
    emit_progress(&app, "Installing Claude Code via npm...");
    let result = run_streaming(
        &app,
        "npm",
        &[
            "install",
            "-g",
            "--prefix",
            &managed_npm_prefix().to_string_lossy(),
            "@anthropic-ai/claude-code",
        ],
    )
    .await?;
    append_user_path(&managed_npm_bin())?;
    Ok(result)
}

#[cfg(windows)]
async fn install_qmd_windows(app: AppHandle) -> Result<String, String> {
    emit_progress(&app, "Installing qmd via npm (@tobilu/qmd)...");
    let result = run_streaming(
        &app,
        "npm",
        &[
            "install",
            "-g",
            "--prefix",
            &managed_npm_prefix().to_string_lossy(),
            "--no-audit",
            "--no-fund",
            "@tobilu/qmd@latest",
        ],
    )
    .await?;
    append_user_path(&managed_npm_bin())?;

    write_qmd_bash_shim()?;

    Ok(result)
}

#[cfg(windows)]
fn write_qmd_bash_shim() -> Result<(), String> {
    let prefix = managed_npm_prefix();
    write_qmd_bash_shim_in(&prefix)
}

#[cfg(windows)]
fn write_qmd_bash_shim_in(prefix: &Path) -> Result<(), String> {
    let bin_candidates = [
        prefix
            .join("node_modules")
            .join("@tobilu")
            .join("qmd")
            .join("qmd"),
        prefix.join("node_modules").join("qmd").join("qmd"),
    ];
    let bin_rel: &str = if bin_candidates[0].exists() {
        r"node_modules\@tobilu\qmd\qmd"
    } else if bin_candidates[1].exists() {
        r"node_modules\qmd\qmd"
    } else {
        return Err(format!(
            "qmd bin not found at {:?} or {:?} (npm install incomplete)",
            bin_candidates[0], bin_candidates[1]
        ));
    };

    let cmd_path = prefix.join("qmd.cmd");
    let body = format!(
        "@ECHO off\r\n\
        SETLOCAL\r\n\
        bash \"%~dp0{bin_rel}\" %*\r\n"
    );
    std::fs::write(&cmd_path, body).map_err(|e| format!("write {cmd_path:?}: {e}"))?;
    Ok(())
}

#[cfg(windows)]
const RSYNC_BUNDLE_URL: &str = "https://github.com/small-tech/portable-rsync-with-ssh-for-windows/archive/0fc67b2e08ac0b1740982bcec16b3f2eb26151fa.zip";

#[cfg(windows)]
#[tauri::command]
pub async fn install_rsync(app: AppHandle) -> Result<String, String> {
    let managed_rsync = managed_toolchain_dir().join("bin").join("rsync.exe");
    let probe = check_dep_impl("rsync", None);
    if probe.installed && !managed_rsync.exists() {
        emit_progress(&app, "rsync already installed");
        write_rsync_shim()?;
        return Ok("rsync already present; path shim refreshed".to_string());
    }

    let url = std::env::var("HQ_RSYNC_URL").unwrap_or_else(|_| RSYNC_BUNDLE_URL.to_string());
    emit_progress(&app, &format!("Downloading portable rsync from {url}"));

    let bin_dir = managed_toolchain_dir().join("bin");
    std::fs::create_dir_all(&bin_dir).map_err(|e| format!("Failed to mkdir {bin_dir:?}: {e}"))?;

    let url_for_dl = url.clone();
    let bytes =
        tokio::task::spawn_blocking(move || download_bytes_checked(&url_for_dl, "rsync bundle"))
            .await
            .map_err(|e| format!("rsync download task join failed: {e}"))??;
    verify_sha256_bytes("rsync bundle", &bytes, RSYNC_BUNDLE_SHA256)?;

    emit_progress(&app, "Extracting rsync bundle...");
    let staged_bin = managed_toolchain_dir().join(format!(".rsync-bin-{}", Uuid::new_v4()));
    if let Err(e) = extract_rsync_zip_to_bin(&bytes, &staged_bin) {
        let _ = std::fs::remove_dir_all(&staged_bin);
        return Err(e);
    }
    if let Err(e) = ensure_rsync_version(&staged_bin.join("rsync.exe")) {
        let _ = std::fs::remove_dir_all(&staged_bin);
        return Err(e);
    }
    activate_staged_bin_files(&staged_bin, &bin_dir)?;

    append_user_path(&bin_dir)?;

    write_rsync_shim()?;

    Ok(format!("rsync extracted to {bin_dir:?}; path shim wired"))
}

#[cfg(windows)]
fn extract_rsync_zip_to_bin(bytes: &[u8], staged_bin: &Path) -> Result<(), String> {
    let cursor = std::io::Cursor::new(bytes);
    let mut archive =
        zip::ZipArchive::new(cursor).map_err(|e| format!("Invalid rsync zip: {e}"))?;
    std::fs::create_dir_all(staged_bin).map_err(|e| format!("mkdir {staged_bin:?}: {e}"))?;

    let mut extracted_rsync_exe = false;
    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| format!("rsync zip entry {i}: {e}"))?;
        if entry.is_dir() {
            continue;
        }
        let raw_name = entry.name().to_string();
        if zip_raw_name_has_unsafe_component(&raw_name) {
            return Err(format!("rsync zip entry has unsafe path: {raw_name}"));
        }
        let rel_name = entry
            .enclosed_name()
            .ok_or_else(|| format!("rsync zip entry has unsafe path: {raw_name}"))?
            .to_path_buf();

        let comps: Vec<_> = rel_name.components().collect();
        let bin_idx = comps.iter().position(
            |c| matches!(c, std::path::Component::Normal(s) if s.eq_ignore_ascii_case("bin")),
        );
        let Some(bi) = bin_idx else { continue };
        if comps.len() != bi + 2 {
            continue;
        }
        let std::path::Component::Normal(leaf) = comps[bi + 1] else {
            continue;
        };
        let dest = staged_bin.join(leaf);
        if !dest.starts_with(staged_bin) {
            return Err(format!("rsync zip entry escapes staging dir: {raw_name}"));
        }
        let mut out = std::fs::File::create(&dest).map_err(|e| format!("create {dest:?}: {e}"))?;
        std::io::copy(&mut entry, &mut out).map_err(|e| format!("extract {dest:?}: {e}"))?;
        if leaf.eq_ignore_ascii_case("rsync.exe") {
            extracted_rsync_exe = true;
        }
    }

    if extracted_rsync_exe {
        Ok(())
    } else {
        Err(
            "rsync bundle did not contain bin/rsync.exe - set HQ_RSYNC_URL to a different mirror"
                .to_string(),
        )
    }
}

#[cfg(windows)]
fn activate_staged_bin_files(staged_bin: &Path, bin_dir: &Path) -> Result<(), String> {
    std::fs::create_dir_all(bin_dir).map_err(|e| format!("mkdir {bin_dir:?}: {e}"))?;
    for entry in std::fs::read_dir(staged_bin).map_err(|e| format!("read {staged_bin:?}: {e}"))? {
        let entry = entry.map_err(|e| format!("read staged rsync entry: {e}"))?;
        let file_type = entry
            .file_type()
            .map_err(|e| format!("stat staged rsync entry {:?}: {e}", entry.path()))?;
        if !file_type.is_file() {
            continue;
        }
        let dest = bin_dir.join(entry.file_name());
        atomic_replace_file(&entry.path(), &dest)?;
    }
    std::fs::remove_dir_all(staged_bin)
        .map_err(|e| format!("remove staged rsync dir {staged_bin:?}: {e}"))
}

#[cfg(windows)]
fn ensure_rsync_version(rsync_exe: &Path) -> Result<(), String> {
    let output = Command::new(rsync_exe)
        .arg("--version")
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| format!("failed to run {} --version: {e}", rsync_exe.display()))?;
    let combined = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    if output.status.success() && combined.to_ascii_lowercase().contains("rsync") {
        Ok(())
    } else {
        Err(format!(
            "rsync version check failed: '{}'",
            combined.lines().next().unwrap_or("").trim()
        ))
    }
}

#[cfg(windows)]
fn write_rsync_shim() -> Result<(), String> {
    let bin_dir = managed_npm_bin();
    write_rsync_shim_in(&bin_dir)
}

#[cfg(windows)]
fn write_rsync_shim_in(bin_dir: &Path) -> Result<(), String> {
    std::fs::create_dir_all(bin_dir).map_err(|e| format!("mkdir {bin_dir:?}: {e}"))?;

    let cmd_path = bin_dir.join("rsync.cmd");
    let ps1_path = bin_dir.join("rsync.ps1");

    let cmd_body = "@echo off\r\n\
        powershell -NoProfile -ExecutionPolicy Bypass -File \"%~dpn0.ps1\" %*\r\n";
    std::fs::write(&cmd_path, cmd_body).map_err(|e| format!("write {cmd_path:?}: {e}"))?;

    let ps1_body = r#"# rsync.ps1 - Windows path translator for cwRsync
# Generated by hq-installer. Translates Windows absolute paths
# (X:\foo\bar) into cygwin paths (/cygdrive/x/foo/bar) before invoking
# cwRsync, which can't parse colons in args.

$translated = @()
foreach ($a in $args) {
    if ($a -match '^([A-Za-z]):[\\/](.*)$') {
        $drive = $matches[1].ToLower()
        $rest  = ($matches[2] -replace '\\', '/')
        $translated += "/cygdrive/$drive/$rest"
    } else {
        $translated += $a
    }
}

$managedRsync = Join-Path $env:LOCALAPPDATA 'IndigoHQ\toolchain\bin\rsync.exe'
$realRsync = $null
if (Test-Path $managedRsync) {
    $realRsync = $managedRsync
} else {
    $realRsync = (Get-Command rsync.exe -ErrorAction SilentlyContinue | Where-Object { $_.Source -notmatch 'IndigoHQ\\toolchain\\bin\\rsync\.(cmd|ps1)$' } | Select-Object -First 1).Source
}
if (-not $realRsync) {
    Write-Error 'rsync shim: real rsync.exe not found'
    exit 127
}

& $realRsync @translated
exit $LASTEXITCODE
"#;
    std::fs::write(&ps1_path, ps1_body).map_err(|e| format!("write {ps1_path:?}: {e}"))?;

    Ok(())
}

#[cfg(windows)]
fn write_shasum_shim() -> Result<(), String> {
    let bin_dir = managed_toolchain_dir().join("bin");
    write_shasum_shim_in(&bin_dir)
}

#[cfg(windows)]
fn write_shasum_shim_in(bin_dir: &Path) -> Result<(), String> {
    std::fs::create_dir_all(bin_dir).map_err(|e| format!("mkdir {bin_dir:?}: {e}"))?;

    let shim_path = bin_dir.join("shasum");
    let shim_body = "#!/usr/bin/env bash\n\
# shasum shim - HQ installer (Windows). Maps `shasum -a <algo>` onto the\n\
# native shaNsum tools Git Bash ships, so macOS-authored hq-core scripts run\n\
# unchanged. Generated by hq-installer deps.rs::write_shasum_shim.\n\
algo=256\n\
out=()\n\
while [ $# -gt 0 ]; do\n\
  case \"$1\" in\n\
    -a|--algorithm) algo=\"$2\"; shift 2 ;;\n\
    -a*) algo=\"${1#-a}\"; shift ;;\n\
    -b|-t|-U|-p|--binary|--text|--portable|--UNIVERSAL) shift ;;\n\
    *) out+=(\"$1\"); shift ;;\n\
  esac\n\
done\n\
case \"$algo\" in\n\
  1)   exec sha1sum \"${out[@]}\" ;;\n\
  224) exec sha224sum \"${out[@]}\" ;;\n\
  256) exec sha256sum \"${out[@]}\" ;;\n\
  384) exec sha384sum \"${out[@]}\" ;;\n\
  512) exec sha512sum \"${out[@]}\" ;;\n\
  *)   exec sha256sum \"${out[@]}\" ;;\n\
esac\n";
    std::fs::write(&shim_path, shim_body).map_err(|e| format!("write {shim_path:?}: {e}"))?;

    Ok(())
}

#[cfg(windows)]
#[tauri::command]
pub fn ensure_shims() -> Result<String, String> {
    write_rsync_shim()?;
    write_shasum_shim()?;
    Ok("shims ready".to_string())
}

#[cfg(windows)]
async fn install_hq_cli_windows(app: AppHandle) -> Result<String, String> {
    emit_progress(&app, "Installing @indigoai-us/hq-cli from npmjs.org...");
    let result_inner = run_streaming(
        &app,
        "npm",
        &[
            "install",
            "-g",
            "--prefix",
            &managed_npm_prefix().to_string_lossy(),
            "--@indigoai-us:registry=https://registry.npmjs.org/",
            "--registry=https://registry.npmjs.org/",
            "@indigoai-us/hq-cli",
        ],
    )
    .await?;
    append_user_path(&managed_npm_bin())?;

    patch_hq_cli_pack_install_rsync()?;

    Ok(result_inner)
}

#[cfg(windows)]
fn patch_hq_cli_pack_install_rsync() -> Result<(), String> {
    let target = managed_npm_prefix()
        .join("node_modules")
        .join("@indigoai-us")
        .join("hq-cli")
        .join("dist")
        .join("commands")
        .join("pack-install.js");
    patch_hq_cli_pack_install_rsync_at(&target)
}

#[cfg(windows)]
fn patch_hq_cli_pack_install_rsync_at(target: &Path) -> Result<(), String> {
    if !target.exists() {
        return Err(format!("pack-install.js not found at {target:?}"));
    }

    let content = std::fs::read_to_string(target).map_err(|e| format!("read {target:?}: {e}"))?;

    const MARKER: &str = "/* hq-installer: rsync -> fs.cpSync patch applied */";
    if content.contains(MARKER) {
        return Ok(());
    }

    const NEEDLE_MULTI: &str = "execFileSync('rsync', [\n        '-a',\n        '--exclude=.git',\n        '--exclude=node_modules',\n        '--exclude=.DS_Store',\n        srcSlashed,\n        destSlashed,\n    ], { stdio: 'inherit' });";
    const NEEDLE_SIMPLE_DEST: &str =
        "execFileSync('rsync', ['-a', srcSlashed, destSlashed], { stdio: 'inherit' });";
    const NEEDLE_SIMPLE_STAGING: &str =
        "execFileSync('rsync', ['-a', srcSlashed, stagingSlashed], { stdio: 'inherit' });";

    let replace_multi = format!(
        "{MARKER}\n    fs.cpSync(srcSlashed, destSlashed, {{\n        recursive: true,\n        filter: (s) => {{\n            const b = path.basename(s);\n            return b !== '.git' && b !== 'node_modules' && b !== '.DS_Store';\n        }},\n    }});"
    );
    let replace_simple =
        |dest_var: &str| format!("fs.cpSync(srcSlashed, {dest_var}, {{ recursive: true }});");

    let mut matched_any = false;
    let mut patched = content.clone();
    if patched.contains(NEEDLE_MULTI) {
        patched = patched.replace(NEEDLE_MULTI, &replace_multi);
        matched_any = true;
    }
    if patched.contains(NEEDLE_SIMPLE_DEST) {
        patched = patched.replace(NEEDLE_SIMPLE_DEST, &replace_simple("destSlashed"));
        matched_any = true;
    }
    if patched.contains(NEEDLE_SIMPLE_STAGING) {
        patched = patched.replace(NEEDLE_SIMPLE_STAGING, &replace_simple("stagingSlashed"));
        matched_any = true;
    }

    if !matched_any {
        return Err("expected execFileSync('rsync', ...) blocks not found - \
             hq-cli may have changed its pack-install.js format. \
             Re-run installer or patch manually."
            .to_string());
    }

    std::fs::write(target, patched).map_err(|e| format!("write {target:?}: {e}"))?;
    Ok(())
}

#[cfg(all(test, windows))]
mod windows_tests {
    use super::*;
    use std::io::Write as _;

    fn zip_fixture(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let cursor = std::io::Cursor::new(Vec::new());
        let mut writer = zip::ZipWriter::new(cursor);
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Stored);
        for (name, bytes) in entries {
            if name.ends_with('/') {
                writer.add_directory(*name, options).unwrap();
            } else {
                writer.start_file(*name, options).unwrap();
                writer.write_all(bytes).unwrap();
            }
        }
        writer.finish().unwrap().into_inner()
    }

    #[test]
    fn managed_node_zip_extracts_expected_root() {
        let tmp = tempfile::tempdir().unwrap();
        let root = format!("node-{WINDOWS_MANAGED_NODE_VERSION}-win-x64");
        let node = format!("{root}/node.exe");
        let npm = format!("{root}/npm.cmd");
        let npx = format!("{root}/npx.cmd");
        let bytes = zip_fixture(&[
            (&node, b"node"),
            (&npm, b"npm"),
            (&npx, b"npx"),
            (&format!("{root}/README.md"), b"readme"),
        ]);

        extract_managed_node_zip(&bytes, WINDOWS_MANAGED_NODE_VERSION, "x64", tmp.path())
            .expect("node zip should extract");

        assert_eq!(std::fs::read(tmp.path().join("node.exe")).unwrap(), b"node");
        assert_eq!(std::fs::read(tmp.path().join("npm.cmd")).unwrap(), b"npm");
        assert_eq!(std::fs::read(tmp.path().join("npx.cmd")).unwrap(), b"npx");
        assert_eq!(
            std::fs::read(tmp.path().join("README.md")).unwrap(),
            b"readme"
        );
    }

    #[test]
    fn managed_node_zip_rejects_unsafe_or_wrong_root_entries() {
        let tmp = tempfile::tempdir().unwrap();
        let root = format!("node-{WINDOWS_MANAGED_NODE_VERSION}-win-x64");
        let unsafe_name = format!("{root}/../evil.exe");
        let unsafe_zip = zip_fixture(&[(&unsafe_name, b"evil")]);
        let err =
            extract_managed_node_zip(&unsafe_zip, WINDOWS_MANAGED_NODE_VERSION, "x64", tmp.path())
                .unwrap_err();
        assert!(err.contains("unsafe path"), "{err}");

        let wrong_root = zip_fixture(&[
            ("node-wrong-win-x64/node.exe", b"node"),
            ("node-wrong-win-x64/npm.cmd", b"npm"),
            ("node-wrong-win-x64/npx.cmd", b"npx"),
        ]);
        let err =
            extract_managed_node_zip(&wrong_root, WINDOWS_MANAGED_NODE_VERSION, "x64", tmp.path())
                .unwrap_err();
        assert!(err.contains("outside expected root"), "{err}");
    }

    #[test]
    fn yq_download_status_and_staged_write_are_hermetic() {
        let err = fetch_asset_with("https://example.invalid/yq", "yq", |_| {
            Ok(DownloadedAsset {
                status: 404,
                bytes: b"not found".to_vec(),
            })
        })
        .unwrap_err();
        assert!(err.contains("HTTP status 404"), "{err}");

        let tmp = tempfile::tempdir().unwrap();
        let target = tmp.path().join("yq.exe");
        std::fs::write(&target, b"old").unwrap();
        let bytes = b"fixture-yq";
        let sha = sha256_hex(bytes);
        install_yq_windows_from_bytes(bytes, &sha, &target, |staged| {
            assert!(staged.exists());
            assert_eq!(std::fs::read(staged).unwrap(), bytes);
            Ok(())
        })
        .expect("verified yq bytes should install");
        assert_eq!(std::fs::read(&target).unwrap(), bytes);

        let err =
            install_yq_windows_from_bytes(b"tampered", &sha, &target, |_| Ok(())).unwrap_err();
        assert!(err.contains("checksum mismatch"), "{err}");
        assert_eq!(std::fs::read(&target).unwrap(), bytes);
    }

    #[test]
    fn rsync_zip_extracts_bin_and_rejects_bad_archives() {
        let tmp = tempfile::tempdir().unwrap();
        let bytes = zip_fixture(&[
            ("portable-rsync/bin/rsync.exe", b"rsync"),
            ("portable-rsync/bin/ssh.exe", b"ssh"),
            ("portable-rsync/docs/readme.txt", b"ignored"),
        ]);
        extract_rsync_zip_to_bin(&bytes, tmp.path()).expect("rsync zip should extract");
        assert_eq!(
            std::fs::read(tmp.path().join("rsync.exe")).unwrap(),
            b"rsync"
        );
        assert_eq!(std::fs::read(tmp.path().join("ssh.exe")).unwrap(), b"ssh");
        assert!(!tmp.path().join("readme.txt").exists());

        let unsafe_zip = zip_fixture(&[("../evil.exe", b"evil")]);
        let err = extract_rsync_zip_to_bin(&unsafe_zip, tmp.path()).unwrap_err();
        assert!(err.contains("unsafe path"), "{err}");

        let missing = zip_fixture(&[("portable-rsync/bin/ssh.exe", b"ssh")]);
        let err = extract_rsync_zip_to_bin(&missing, tmp.path()).unwrap_err();
        assert!(err.contains("bin/rsync.exe"), "{err}");
    }

    #[test]
    fn shim_writers_emit_expected_files() {
        let tmp = tempfile::tempdir().unwrap();
        let qmd_prefix = tmp.path().join("npm-prefix");
        let qmd_bin = qmd_prefix
            .join("node_modules")
            .join("@tobilu")
            .join("qmd")
            .join("qmd");
        std::fs::create_dir_all(qmd_bin.parent().unwrap()).unwrap();
        std::fs::write(&qmd_bin, b"").unwrap();
        write_qmd_bash_shim_in(&qmd_prefix).expect("qmd shim should write");
        let qmd_cmd = std::fs::read_to_string(qmd_prefix.join("qmd.cmd")).unwrap();
        assert!(qmd_cmd.contains("bash \"%~dp0node_modules\\@tobilu\\qmd\\qmd\" %*"));

        let npm_bin = tmp.path().join("npm-bin");
        write_rsync_shim_in(&npm_bin).expect("rsync shims should write");
        assert!(npm_bin.join("rsync.cmd").is_file());
        let ps1 = std::fs::read_to_string(npm_bin.join("rsync.ps1")).unwrap();
        assert!(ps1.contains("/cygdrive/$drive/$rest"));

        let tool_bin = tmp.path().join("tool-bin");
        write_shasum_shim_in(&tool_bin).expect("shasum shim should write");
        let shasum = std::fs::read_to_string(tool_bin.join("shasum")).unwrap();
        assert!(shasum.contains("exec sha256sum"));
    }

    #[test]
    fn hq_cli_pack_install_patch_rewrites_rsync_once() {
        let tmp = tempfile::tempdir().unwrap();
        let target = tmp.path().join("pack-install.js");
        let source = "import fs from 'fs';\nimport path from 'path';\nfunction copy(srcSlashed, destSlashed) {\n    execFileSync('rsync', [\n        '-a',\n        '--exclude=.git',\n        '--exclude=node_modules',\n        '--exclude=.DS_Store',\n        srcSlashed,\n        destSlashed,\n    ], { stdio: 'inherit' });\n}\n";
        std::fs::write(&target, source).unwrap();

        patch_hq_cli_pack_install_rsync_at(&target).expect("patch should apply");
        patch_hq_cli_pack_install_rsync_at(&target).expect("patch should be idempotent");

        let patched = std::fs::read_to_string(&target).unwrap();
        assert!(patched.contains("hq-installer: rsync -> fs.cpSync patch applied"));
        assert!(patched.contains("fs.cpSync(srcSlashed, destSlashed"));
        assert!(!patched.contains("execFileSync('rsync'"));
        assert_eq!(
            patched
                .matches("hq-installer: rsync -> fs.cpSync patch applied")
                .count(),
            1
        );
    }

    #[test]
    fn registry_path_decode_rejects_non_string_values() {
        let raw = RegValue {
            bytes: vec![1, 2, 3, 4],
            vtype: winreg::enums::REG_BINARY,
        };
        let err = decode_registry_string(&raw, "Path").unwrap_err();
        assert!(err.contains("unsupported registry type"), "{err}");
    }

    #[test]
    fn managed_toolchain_dir_under_localappdata() {
        let dir = managed_toolchain_dir();
        let path_str = dir.to_string_lossy().to_lowercase();
        assert!(path_str.contains("indigohq"));
        assert!(path_str.contains("toolchain"));
    }

    #[test]
    fn extended_search_path_contains_system32_and_managed_node() {
        let path = extended_search_path();
        let lower = path.to_lowercase();
        assert!(lower.contains("system32"), "PATH should include System32");
        assert!(
            lower.contains("indigohq") && lower.contains("toolchain"),
            "PATH should include the managed toolchain dir"
        );
    }

    #[test]
    fn managed_node_arch_maps_known_archs() {
        match std::env::consts::ARCH {
            "x86_64" => assert_eq!(managed_node_arch(), Some("x64")),
            "aarch64" => assert_eq!(managed_node_arch(), Some("arm64")),
            _ => assert_eq!(managed_node_arch(), None),
        }
    }

    #[test]
    fn user_path_append_then_remove_round_trip() {
        let unique = format!(
            "C:\\hq-test-{}",
            uuid::Uuid::new_v4().to_string().replace('-', "")
        );
        let p = PathBuf::from(&unique);

        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let env = hkcu
            .open_subkey_with_flags("Environment", KEY_READ | KEY_SET_VALUE)
            .expect("HKCU\\Environment open");
        let before: String = env.get_value("Path").unwrap_or_default();

        append_user_path(&p).expect("append should succeed");
        let after_add: String = env.get_value("Path").unwrap_or_default();
        assert!(
            after_add
                .split(';')
                .any(|e| e.eq_ignore_ascii_case(&unique)),
            "PATH should contain unique entry after append"
        );

        append_user_path(&p).expect("second append should succeed");
        let after_reappend: String = env.get_value("Path").unwrap_or_default();
        assert_eq!(after_add, after_reappend, "second append should be a no-op");

        remove_user_path(&p).expect("remove should succeed");
        let after_remove: String = env.get_value("Path").unwrap_or_default();
        assert!(
            !after_remove
                .split(';')
                .any(|e| e.eq_ignore_ascii_case(&unique)),
            "PATH should not contain unique entry after remove"
        );

        let entries = |s: &str| {
            s.split(';')
                .filter(|e| !e.is_empty())
                .map(str::to_owned)
                .collect::<Vec<_>>()
        };
        assert_eq!(
            entries(&after_remove),
            entries(&before),
            "PATH entries should be restored to before (modulo empty segments)"
        );

        env.set_value("Path", &before)
            .expect("restore original PATH");
    }
}
