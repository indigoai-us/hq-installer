//! Streamed subprocess with cancellation.
//!
//! `spawn_process` — spawns a child, streams stdout as `process://{handle}/stdout`
//!                    events, emits `process://{handle}/exit` on termination.
//! `cancel_process` — sends SIGTERM to the process group; after 5 s, SIGKILL.

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
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::Duration;

#[cfg(unix)]
use nix::sys::signal::{self, Signal};
#[cfg(unix)]
use nix::unistd::Pid;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use uuid::Uuid;
#[cfg(windows)]
use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
#[cfg(windows)]
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
    SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};
#[cfg(windows)]
use windows_sys::Win32::System::Threading::{OpenProcess, TerminateProcess, PROCESS_TERMINATE};

#[cfg(windows)]
use super::deps::extended_search_path;
#[cfg(unix)]
use super::deps::{extended_search_path, managed_git_env};
use super::fs::guard_absolute_path_under_root;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/// Arguments for `spawn_process`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnArgs {
    pub program: String,
    pub args: Vec<String>,
    pub cwd: Option<String>,
    pub env: Option<HashMap<String, String>>,
    pub install_root: String,
}

/// Payload for `process://{handle}/stdout` events.
#[derive(Debug, Serialize, Clone)]
pub struct StdoutEvent {
    pub line: String,
}

/// Payload for `process://{handle}/stderr` events.
#[derive(Debug, Serialize, Clone)]
pub struct StderrEvent {
    pub line: String,
}

/// Payload for the terminal `process://{handle}/exit` event.
#[derive(Debug, Serialize, Clone)]
pub struct ExitEvent {
    pub code: Option<i32>,
    pub success: bool,
}

// ─────────────────────────────────────────────────────────────────────────────
// Windows Job Object handle
// ─────────────────────────────────────────────────────────────────────────────

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
            "CreateJobObjectW failed: error code {}",
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
        unsafe { CloseHandle(job) };
        return Err(format!(
            "SetInformationJobObject failed: error code {}",
            err
        ));
    }

    Ok(JobHandle(job))
}

#[cfg(windows)]
fn assign_process_to_job(job: HANDLE, process: HANDLE) -> Result<(), String> {
    let result = unsafe { AssignProcessToJobObject(job, process) };
    if result == 0 {
        return Err(format!(
            "AssignProcessToJobObject failed: error code {}",
            std::io::Error::last_os_error()
        ));
    }
    Ok(())
}

#[cfg(windows)]
fn terminate_job(job: HANDLE) -> Result<(), String> {
    let result = unsafe { TerminateJobObject(job, 1) };
    if result == 0 {
        return Err(format!(
            "TerminateJobObject failed: error code {}",
            std::io::Error::last_os_error()
        ));
    }
    Ok(())
}

#[cfg(windows)]
fn terminate_process(pid: u32) -> Result<(), String> {
    let process = unsafe { OpenProcess(PROCESS_TERMINATE, 0, pid) };
    if process.is_null() {
        return Err(format!(
            "OpenProcess({pid}) failed: error code {}",
            std::io::Error::last_os_error()
        ));
    }

    let result = unsafe { TerminateProcess(process, 1) };
    let err = std::io::Error::last_os_error();
    unsafe {
        CloseHandle(process);
    }
    if result == 0 {
        return Err(format!("TerminateProcess({pid}) failed: error code {err}"));
    }
    Ok(())
}

// ─────────────────────────────────────────────────────────────────────────────
// Process registry
//
// Stores one entry per handle with:
//   - `pid`       — OS pid, None until the child has actually been spawned
//   - `cancelled` — set to true when cancel_process is called, so the thread
//                   checks it before spawning and skips the work entirely
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Default)]
struct ProcessEntry {
    pid: Option<u32>,
    #[cfg(windows)]
    job: Option<Arc<JobHandle>>,
    cancelled: bool,
}

static PROCESS_REGISTRY: OnceLock<Arc<Mutex<HashMap<String, ProcessEntry>>>> = OnceLock::new();

fn process_registry() -> &'static Arc<Mutex<HashMap<String, ProcessEntry>>> {
    PROCESS_REGISTRY.get_or_init(|| Arc::new(Mutex::new(HashMap::new())))
}

/// Pre-register a handle before the background thread starts.  This prevents
/// a `cancel_process` call that arrives before `child.spawn()` from being
/// silently dropped.
fn pre_register_handle(handle: &str) {
    process_registry()
        .lock()
        .unwrap()
        .insert(handle.to_string(), ProcessEntry::default());
}

/// Update the pid once the child has been spawned.  Exposed for tests.
pub fn register_process(handle: &str, pid: u32) {
    let mut reg = process_registry().lock().unwrap();
    if let Some(entry) = reg.get_mut(handle) {
        entry.pid = Some(pid);
    } else {
        reg.insert(
            handle.to_string(),
            ProcessEntry {
                pid: Some(pid),
                #[cfg(windows)]
                job: None,
                cancelled: false,
            },
        );
    }
}

#[cfg(windows)]
fn register_job(handle: &str, job: Arc<JobHandle>) {
    let mut reg = process_registry().lock().unwrap();
    if let Some(entry) = reg.get_mut(handle) {
        entry.job = Some(job);
    }
}

/// Remove a handle from the registry (called on process exit).
pub fn deregister_process(handle: &str) {
    process_registry().lock().unwrap().remove(handle);
}

/// Look up the OS pid for `handle`.  Returns `None` if not registered or not
/// yet spawned.
pub fn lookup_pid(handle: &str) -> Option<u32> {
    process_registry()
        .lock()
        .unwrap()
        .get(handle)
        .and_then(|e| e.pid)
}

#[cfg(windows)]
fn lookup_job(handle: &str) -> Option<Arc<JobHandle>> {
    process_registry()
        .lock()
        .unwrap()
        .get(handle)
        .and_then(|e| e.job.clone())
}

#[cfg(unix)]
fn is_registered(handle: &str) -> bool {
    process_registry().lock().unwrap().contains_key(handle)
}

fn is_cancelled(handle: &str) -> bool {
    process_registry()
        .lock()
        .unwrap()
        .get(handle)
        .map(|e| e.cancelled)
        .unwrap_or(false)
}

fn mark_cancelled(handle: &str) -> bool {
    let mut reg = process_registry().lock().unwrap();
    if let Some(entry) = reg.get_mut(handle) {
        entry.cancelled = true;
        true
    } else {
        false
    }
}

struct ProcessRegistrationGuard<'a> {
    handle: &'a str,
}

impl Drop for ProcessRegistrationGuard<'_> {
    fn drop(&mut self) {
        deregister_process(self.handle);
    }
}

impl<'a> ProcessRegistrationGuard<'a> {
    fn new(handle: &'a str) -> Self {
        Self { handle }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Event enum (testable without Tauri)
// ─────────────────────────────────────────────────────────────────────────────

/// Events emitted during process execution.
pub enum ProcessEvent {
    Stdout(String),
    Stderr(String),
    Exit { code: Option<i32>, success: bool },
}

const ALLOWED_PROGRAMS: &[&str] = &["npx", "bash", "hq", "qmd"];
const ALLOWED_ENV_KEYS: &[&str] = &["HQ_ROOT"];

fn ensure_allowed_program(program: &str) -> Result<(), String> {
    if ALLOWED_PROGRAMS.contains(&program) {
        Ok(())
    } else {
        Err(format!(
            "program not allowed for spawn_process: {program}. Allowed programs: npx, bash, hq, qmd"
        ))
    }
}

fn validated_cwd(spawn: &SpawnArgs) -> Result<Option<PathBuf>, String> {
    spawn
        .cwd
        .as_deref()
        .map(|cwd| guard_absolute_path_under_root(cwd, &spawn.install_root))
        .transpose()
}

fn resolve_allowed_program(spawn: &SpawnArgs, search_path: &str) -> Result<PathBuf, String> {
    ensure_allowed_program(&spawn.program)?;
    let cwd_for_which =
        validated_cwd(spawn)?.unwrap_or_else(|| std::env::current_dir().unwrap_or_default());
    which::which_in(&spawn.program, Some(search_path), cwd_for_which)
        .map_err(|_| format!("command not found on PATH: {}", spawn.program))
}

fn apply_allowed_env(cmd: &mut Command, env: &Option<HashMap<String, String>>) {
    if let Some(env) = env {
        for (k, v) in env {
            if ALLOWED_ENV_KEYS.contains(&k.as_str()) {
                cmd.env(k, v);
            }
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure impl
// ─────────────────────────────────────────────────────────────────────────────

/// Spawn the process described by `spawn`, update its registry entry with the
/// OS pid, stream stdout + stderr lines to `on_event`, then emit the exit
/// event.  Blocks until the process exits.
///
/// `search_path` is used to resolve allowed bare program names (e.g. `qmd`, `npx`)
/// to absolute paths via `which::which_in` before spawning. GUI-launched
/// Tauri apps inherit only `/usr/bin:/bin` from LaunchServices, so passing
/// the caller's bare program directly to `Command::new` would fail to locate
/// binaries installed under nvm, Homebrew, `~/.local/bin`, etc. Resolving
/// up-front also means spawn failures surface synchronously — no race
/// window between "spawn failed on background thread" and "JS registers
/// exit listener" that previously left the indexing UI stuck at "Running…".
///
/// The search path is also set as the child's `PATH` env so grandchildren
/// (e.g. `qmd` → `git`, `npm` → `node`) find their own tools. A caller-
/// supplied `PATH` in `spawn.env` wins.
///
/// The child is placed in its own process group so that cancellation can
/// signal the whole group (covers wrappers like `sh -c` or `npm run`).
///
/// stdout and stderr are each read on their own thread so one blocking on
/// the other never deadlocks (e.g. a chatty stderr filling a pipe while
/// stdout is idle).
///
/// All error paths reap the child and deregister the handle so no stale
/// registry entries or zombie processes are left behind.
#[cfg(unix)]
pub fn run_process_impl<F>(
    handle: &str,
    spawn: &SpawnArgs,
    search_path: &str,
    on_event: F,
) -> Result<(), String>
where
    F: FnMut(ProcessEvent),
{
    let _registration_guard = ProcessRegistrationGuard::new(handle);

    // Resolve the allowlisted program via the caller-supplied search path.
    let resolved = resolve_allowed_program(spawn, search_path)?;
    let cwd = validated_cwd(spawn)?;

    let mut cmd = Command::new(&resolved);
    cmd.args(&spawn.args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        // Place the child in its own process group (pgid == child pid).
        // This lets cancel_process signal the whole group, not just the leader.
        .process_group(0);

    if let Some(cwd) = &cwd {
        cmd.current_dir(cwd);
    }

    // Seed the child's PATH from the search path so grandchildren inherit
    // the extended PATH. Prepend the resolved binary's parent directory so
    // wrapper scripts (e.g. qmd) find co-located tools first.
    //
    // nvm ABI-pin fix: ~/.nvm/vX/bin/qmd lives next to node vX; without the
    // prepend the wrapper's `command -v node` picks the shell-default node (vY)
    // and better-sqlite3 crashes with ERR_DLOPEN_FAILED.
    //
    // All current spawn_process callers use allowlisted installer tools:
    // npx, bash, hq, and qmd. Prepending the resolved binary's directory is
    // primarily for qmd and npx wrappers that need their co-located node first.
    //
    // Dedup: skip prepend when bin_dir is already the leading PATH component
    // to avoid duplicate entries (common when the extended search path already
    // includes the binary's directory).
    //
    let child_path = if let Some(bin_dir) = resolved.parent() {
        let bin_str = bin_dir.to_string_lossy();
        let already_first = search_path
            .split(':')
            .next()
            .map(|first| first == bin_str.as_ref())
            .unwrap_or(false);
        if already_first {
            search_path.to_string()
        } else {
            format!("{}:{}", bin_str, search_path)
        }
    } else {
        search_path.to_string()
    };
    cmd.env("PATH", &child_path);
    // A relocatable managed (dugite) git needs its exec-path/templates/CA bundle
    // set explicitly, so any `git` a child shells out to (e.g. `hq install`'s
    // github clone) works without a system git. No-op when the managed git isn't
    // installed. Caller-supplied env (applied below) wins.
    for (k, v) in managed_git_env() {
        cmd.env(k, v);
    }
    apply_allowed_env(&mut cmd, &spawn.env);

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("spawn '{}': {}", spawn.program, e))?;

    let pid = child.id();
    register_process(handle, pid);

    let stdout = child.stdout.take().expect("stdout pipe");
    let stderr = child.stderr.take().expect("stderr pipe");

    // mpsc channel: reader threads produce events, main thread consumes and
    // forwards to on_event in real time. Using a channel keeps on_event on
    // the caller's thread (so F doesn't need Send) while stream I/O still
    // runs in parallel.
    enum ReaderMsg {
        Event(ProcessEvent),
        /// Reader finished (either EOF or fatal read error).
        Done {
            stream: &'static str,
            err: Option<String>,
        },
    }

    let (tx, rx) = mpsc::channel::<ReaderMsg>();

    // stdout reader
    let tx_stdout = tx.clone();
    thread::spawn(move || {
        let mut err: Option<String> = None;
        for line_result in BufReader::new(stdout).lines() {
            match line_result {
                Ok(line) => {
                    if tx_stdout
                        .send(ReaderMsg::Event(ProcessEvent::Stdout(line)))
                        .is_err()
                    {
                        return;
                    }
                }
                Err(e) => {
                    err = Some(e.to_string());
                    break;
                }
            }
        }
        let _ = tx_stdout.send(ReaderMsg::Done {
            stream: "stdout",
            err,
        });
    });

    // stderr reader
    let tx_stderr = tx.clone();
    thread::spawn(move || {
        let mut err: Option<String> = None;
        for line_result in BufReader::new(stderr).lines() {
            match line_result {
                Ok(line) => {
                    if tx_stderr
                        .send(ReaderMsg::Event(ProcessEvent::Stderr(line)))
                        .is_err()
                    {
                        return;
                    }
                }
                Err(e) => {
                    err = Some(e.to_string());
                    break;
                }
            }
        }
        let _ = tx_stderr.send(ReaderMsg::Done {
            stream: "stderr",
            err,
        });
    });

    // Drop the original sender so the rx loop terminates once both readers
    // have dropped their clones.
    drop(tx);

    let mut on_event_mut = on_event;
    let mut first_stream_err: Option<String> = None;
    let mut done_count = 0;

    for msg in rx {
        match msg {
            ReaderMsg::Event(ev) => on_event_mut(ev),
            ReaderMsg::Done { stream, err } => {
                if let Some(e) = err {
                    if first_stream_err.is_none() {
                        first_stream_err = Some(format!("{}: {}", stream, e));
                    }
                }
                done_count += 1;
                if done_count == 2 {
                    break;
                }
            }
        }
    }

    let wait_result = child.wait().map_err(|e| e.to_string());
    deregister_process(handle);

    if let Some(err) = first_stream_err {
        on_event_mut(ProcessEvent::Exit {
            code: None,
            success: false,
        });
        return Err(err);
    }

    let status = wait_result?;
    on_event_mut(ProcessEvent::Exit {
        code: status.code(),
        success: status.success(),
    });

    Ok(())
}

#[cfg(windows)]
pub fn run_process_impl<F>(
    handle: &str,
    spawn: &SpawnArgs,
    search_path: &str,
    on_event: F,
) -> Result<(), String>
where
    F: FnMut(ProcessEvent),
{
    let _registration_guard = ProcessRegistrationGuard::new(handle);

    let resolved = resolve_allowed_program(spawn, search_path)?;
    let cwd = validated_cwd(spawn)?;

    let mut cmd = Command::new(&resolved);
    cmd.args(&spawn.args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .creation_flags(CREATE_NO_WINDOW);

    if let Some(cwd) = &cwd {
        cmd.current_dir(cwd);
    }

    let child_path = if let Some(bin_dir) = resolved.parent() {
        let bin_str = bin_dir.to_string_lossy();
        let already_first = search_path
            .split(';')
            .next()
            .map(|first| first == bin_str.as_ref())
            .unwrap_or(false);
        if already_first {
            search_path.to_string()
        } else {
            format!("{};{}", bin_str, search_path)
        }
    } else {
        search_path.to_string()
    };
    cmd.env("PATH", &child_path);

    cmd.env(
        "PATHEXT",
        ".CMD;.BAT;.COM;.EXE;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC",
    );

    apply_allowed_env(&mut cmd, &spawn.env);

    let job = Arc::new(create_job_object()?);

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("spawn '{}': {}", spawn.program, e))?;

    let pid = child.id();
    register_process(handle, pid);

    let child_raw = child.as_raw_handle() as HANDLE;
    if let Err(e) = assign_process_to_job(job.0, child_raw) {
        eprintln!("[hq-process] WARN: AssignProcessToJobObject failed for handle={handle}: {e}");
    } else {
        register_job(handle, job.clone());
        if is_cancelled(handle) {
            if let Err(e) = terminate_job(job.0) {
                eprintln!(
                    "[hq-process] WARN: cancel after job registration failed for handle={handle}: {e}"
                );
                if let Err(fallback) = terminate_process(pid) {
                    eprintln!(
                        "[hq-process] WARN: fallback TerminateProcess failed for handle={handle}, pid={pid}: {fallback}"
                    );
                }
            }
        }
    }

    let stdout = child.stdout.take().expect("stdout pipe");
    let stderr = child.stderr.take().expect("stderr pipe");

    enum ReaderMsg {
        Event(ProcessEvent),
        Done {
            stream: &'static str,
            err: Option<String>,
        },
    }

    let (tx, rx) = mpsc::channel::<ReaderMsg>();

    let tx_stdout = tx.clone();
    thread::spawn(move || {
        let mut err: Option<String> = None;
        for line_result in BufReader::new(stdout).lines() {
            match line_result {
                Ok(line) => {
                    if tx_stdout
                        .send(ReaderMsg::Event(ProcessEvent::Stdout(line)))
                        .is_err()
                    {
                        return;
                    }
                }
                Err(e) => {
                    err = Some(e.to_string());
                    break;
                }
            }
        }
        let _ = tx_stdout.send(ReaderMsg::Done {
            stream: "stdout",
            err,
        });
    });

    let tx_stderr = tx.clone();
    thread::spawn(move || {
        let mut err: Option<String> = None;
        for line_result in BufReader::new(stderr).lines() {
            match line_result {
                Ok(line) => {
                    if tx_stderr
                        .send(ReaderMsg::Event(ProcessEvent::Stderr(line)))
                        .is_err()
                    {
                        return;
                    }
                }
                Err(e) => {
                    err = Some(e.to_string());
                    break;
                }
            }
        }
        let _ = tx_stderr.send(ReaderMsg::Done {
            stream: "stderr",
            err,
        });
    });

    drop(tx);

    let mut on_event_mut = on_event;
    let mut first_stream_err: Option<String> = None;
    let mut done_count = 0;

    for msg in rx {
        match msg {
            ReaderMsg::Event(ev) => on_event_mut(ev),
            ReaderMsg::Done { stream, err } => {
                if let Some(e) = err {
                    if first_stream_err.is_none() {
                        first_stream_err = Some(format!("{}: {}", stream, e));
                    }
                }
                done_count += 1;
                if done_count == 2 {
                    break;
                }
            }
        }
    }

    let wait_result = child.wait().map_err(|e| e.to_string());
    deregister_process(handle);

    if let Some(err) = first_stream_err {
        on_event_mut(ProcessEvent::Exit {
            code: None,
            success: false,
        });
        return Err(err);
    }

    let status = wait_result?;
    on_event_mut(ProcessEvent::Exit {
        code: status.code(),
        success: status.success(),
    });

    drop(job);

    Ok(())
}

// ─────────────────────────────────────────────────────────────────────────────
// Cancellation
// ─────────────────────────────────────────────────────────────────────────────

/// Mark `handle` as cancelled and signal its process group.
///
/// - If the child hasn't started yet (pid is None), the cancelled flag causes
///   `run_process_impl` to skip spawning entirely.
/// - If the child is running, SIGTERM is sent to the entire process group,
///   then SIGKILL is sent if the process hasn't exited after `sigkill_delay`.
///
/// Returns `false` if the handle is not registered.
/// Non-blocking: SIGKILL escalation runs in a background thread.
#[cfg(unix)]
pub fn cancel_process_impl(handle: &str, sigkill_delay: Duration) -> bool {
    if !mark_cancelled(handle) {
        return false;
    }

    let pid = match lookup_pid(handle) {
        Some(p) => p,
        // Pre-registered but not yet spawned — the cancelled flag is enough.
        None => return true,
    };

    // Signal the process group (negative pid = pgid) to catch wrappers that fork.
    let pgid = Pid::from_raw(-(pid as i32));
    let _ = signal::kill(pgid, Signal::SIGTERM);

    let handle_owned = handle.to_string();
    thread::spawn(move || {
        thread::sleep(sigkill_delay);
        if is_registered(&handle_owned) {
            // Still alive — escalate to SIGKILL on the process group.
            let _ = signal::kill(Pid::from_raw(-(pid as i32)), Signal::SIGKILL);
            deregister_process(&handle_owned);
        }
    });

    true
}

#[cfg(windows)]
pub fn cancel_process_impl(handle: &str, _sigkill_delay: Duration) -> bool {
    if !mark_cancelled(handle) {
        return false;
    }

    let pid = match lookup_pid(handle) {
        Some(pid) => pid,
        None => return true,
    };

    let mut terminated = false;
    if let Some(job) = lookup_job(handle) {
        match terminate_job(job.0) {
            Ok(()) => terminated = true,
            Err(e) => {
                eprintln!(
                    "[hq-process] WARN: TerminateJobObject failed for handle={handle}, pid={pid}: {e}"
                );
            }
        }
    }

    if !terminated {
        if let Err(e) = terminate_process(pid) {
            eprintln!(
                "[hq-process] WARN: TerminateProcess fallback failed for handle={handle}, pid={pid}: {e}"
            );
        }
    }

    true
}

// ─────────────────────────────────────────────────────────────────────────────
// Tauri commands
// ─────────────────────────────────────────────────────────────────────────────

/// Spawn a subprocess and stream its stdout as `process://{handle}/stdout`
/// events.  A terminal `process://{handle}/exit` event is emitted when the
/// process ends.
///
/// The handle is registered **before** this function returns so that
/// `cancel_process` called immediately after `invoke` is never silently lost.
///
/// The allowlisted program is resolved against the shell-derived extended PATH
/// *synchronously* before returning Ok(handle). If it can't be found, Err is
/// returned and no background thread is ever spawned — this matters because
/// the JS listener registration for `exit` happens after `await invoke()`
/// resolves, so an error event emitted from a background thread could race
/// past it and leave the UI stuck at "Running…".
fn spawn_process_shared(app: AppHandle, args: SpawnArgs) -> Result<String, String> {
    let search_path = extended_search_path();

    // Synchronous pre-resolution — if the binary isn't on the extended PATH,
    // fail before anyone subscribes to exit events. No race possible.
    resolve_allowed_program(&args, &search_path)?;

    let handle = Uuid::new_v4().to_string();

    // Pre-register before the thread starts to eliminate the cancel race.
    pre_register_handle(&handle);

    let handle_bg = handle.clone();
    let search_path_bg = search_path;
    thread::spawn(move || {
        // Respect a cancel that arrived before the process even started.
        if is_cancelled(&handle_bg) {
            deregister_process(&handle_bg);
            let _ = app.emit(
                &format!("process://{}/exit", handle_bg),
                ExitEvent {
                    code: Some(-1),
                    success: false,
                },
            );
            return;
        }

        let result = run_process_impl(&handle_bg, &args, &search_path_bg, |event| match event {
            ProcessEvent::Stdout(line) => {
                let _ = app.emit(
                    &format!("process://{}/stdout", handle_bg),
                    StdoutEvent { line },
                );
            }
            ProcessEvent::Stderr(line) => {
                let _ = app.emit(
                    &format!("process://{}/stderr", handle_bg),
                    StderrEvent { line },
                );
            }
            ProcessEvent::Exit { code, success } => {
                let _ = app.emit(
                    &format!("process://{}/exit", handle_bg),
                    ExitEvent { code, success },
                );
            }
        });

        if let Err(e) = result {
            eprintln!("[hq-process] process failed for handle={handle_bg}: {e}");
            // `run_process_impl` already deregistered; emit error exit.
            let _ = app.emit(
                &format!("process://{}/exit", handle_bg),
                ExitEvent {
                    code: Some(-1),
                    success: false,
                },
            );
        }
    });

    Ok(handle)
}

#[cfg(unix)]
fn spawn_process_unix(app: AppHandle, args: SpawnArgs) -> Result<String, String> {
    spawn_process_shared(app, args)
}

#[cfg(windows)]
fn spawn_process_windows(app: AppHandle, args: SpawnArgs) -> Result<String, String> {
    spawn_process_shared(app, args)
}

#[tauri::command]
pub fn spawn_process(app: AppHandle, args: SpawnArgs) -> Result<String, String> {
    #[cfg(unix)]
    {
        spawn_process_unix(app, args)
    }
    #[cfg(windows)]
    {
        spawn_process_windows(app, args)
    }
}

#[cfg(unix)]
fn cancel_process_unix(handle: String) -> bool {
    cancel_process_impl(&handle, Duration::from_secs(5))
}

#[cfg(windows)]
fn cancel_process_windows(handle: String) -> bool {
    cancel_process_impl(&handle, Duration::from_secs(0))
}

/// Cancel a previously spawned subprocess.
///
/// Unix sends SIGTERM to the process group, then SIGKILL after 5 seconds.
/// Windows terminates the child Job Object immediately.
#[tauri::command]
pub fn cancel_process(handle: String) -> bool {
    #[cfg(unix)]
    {
        cancel_process_unix(handle)
    }
    #[cfg(windows)]
    {
        cancel_process_windows(handle)
    }
}

#[cfg(all(test, unix))]
mod unix_tests {
    use super::*;
    use std::fs;
    use std::os::unix::fs::PermissionsExt;
    use std::process::{Command, Stdio};
    use std::thread;
    use std::time::{Duration, Instant};
    use tempfile::TempDir;

    const TEST_SYSTEM_PATH: &str = "/usr/bin:/bin:/usr/sbin:/sbin";

    #[test]
    fn spawn_failure_deregisters_pre_registered_handle() {
        let tmp = TempDir::new().unwrap();
        let bad_cwd = tmp.path().join("not-a-dir");
        fs::write(&bad_cwd, b"not a directory").unwrap();

        let handle = format!("test-{}", Uuid::new_v4());
        pre_register_handle(&handle);

        let args = SpawnArgs {
            program: "bash".into(),
            args: vec!["hello".into()],
            cwd: Some(bad_cwd.to_string_lossy().into_owned()),
            env: None,
            install_root: tmp.path().to_string_lossy().into_owned(),
        };

        let err = run_process_impl(&handle, &args, TEST_SYSTEM_PATH, |_| {})
            .expect_err("spawn should fail when cwd is not a directory");
        assert!(err.contains("spawn 'bash'"), "unexpected error: {err}");
        assert!(
            !is_registered(&handle),
            "pre-registered handle should be removed on spawn failure"
        );
    }

    #[test]
    fn cancel_process_terminates_unix_process_group() {
        let tmp = TempDir::new().unwrap();
        let pidfile = tmp.path().join("child.pid");
        let script = tmp.path().join("spawn-child.sh");
        fs::write(
            &script,
            format!(
                "#!/bin/sh\nsleep 30 &\necho $! > '{}'\nwait\n",
                pidfile.display()
            ),
        )
        .unwrap();
        let mut perms = fs::metadata(&script).unwrap().permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&script, perms).unwrap();

        let handle = format!("test-pgid-{}", Uuid::new_v4());
        let thread_handle = handle.clone();
        let args = SpawnArgs {
            program: "bash".into(),
            args: vec![script.to_string_lossy().into_owned()],
            cwd: None,
            env: None,
            install_root: tmp.path().to_string_lossy().into_owned(),
        };

        let runner = thread::spawn(move || {
            let _ = run_process_impl(&thread_handle, &args, TEST_SYSTEM_PATH, |_| {});
        });

        let deadline = Instant::now() + Duration::from_secs(3);
        while !pidfile.exists() {
            assert!(
                Instant::now() < deadline,
                "child pidfile was not written before timeout"
            );
            thread::sleep(Duration::from_millis(25));
        }
        assert!(
            lookup_pid(&handle).is_some(),
            "shell process should be registered before cancellation"
        );
        let child_pid: i32 = fs::read_to_string(&pidfile)
            .unwrap()
            .trim()
            .parse()
            .unwrap();

        assert!(cancel_process_impl(&handle, Duration::from_millis(250)));
        runner.join().expect("runner should not panic");

        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            let alive = Command::new("kill")
                .args(["-0", &child_pid.to_string()])
                .stderr(Stdio::null())
                .status()
                .map(|status| status.success())
                .unwrap_or(false);
            if !alive {
                break;
            }
            if Instant::now() >= deadline {
                let _ = Command::new("kill")
                    .args(["-TERM", &child_pid.to_string()])
                    .stderr(Stdio::null())
                    .status();
                panic!("child process {child_pid} survived process-group cancellation");
            }
            thread::sleep(Duration::from_millis(50));
        }
    }
}

#[cfg(all(test, windows))]
mod windows_tests {
    use super::*;
    use std::sync::{Arc, Mutex};
    use std::time::Instant;

    type ExitInfo = Arc<Mutex<Option<(Option<i32>, bool)>>>;

    fn test_path() -> String {
        let system_root = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into());
        format!("{}\\System32", system_root)
    }

    fn run_to_completion(
        handle: &str,
        spawn: SpawnArgs,
    ) -> (Vec<String>, Vec<String>, ExitInfo, Result<(), String>) {
        let stdout = Arc::new(Mutex::new(Vec::<String>::new()));
        let stderr = Arc::new(Mutex::new(Vec::<String>::new()));
        let exit: ExitInfo = Arc::new(Mutex::new(None));

        let stdout_c = stdout.clone();
        let stderr_c = stderr.clone();
        let exit_c = exit.clone();

        let res = run_process_impl(handle, &spawn, &test_path(), move |ev| match ev {
            ProcessEvent::Stdout(line) => stdout_c.lock().unwrap().push(line),
            ProcessEvent::Stderr(line) => stderr_c.lock().unwrap().push(line),
            ProcessEvent::Exit { code, success } => {
                *exit_c.lock().unwrap() = Some((code, success));
            }
        });

        let stdout_v = Arc::try_unwrap(stdout).unwrap().into_inner().unwrap();
        let stderr_v = Arc::try_unwrap(stderr).unwrap().into_inner().unwrap();
        (stdout_v, stderr_v, exit, res)
    }

    #[test]
    fn cmd_echo_streams_stdout_and_exits_zero() {
        let root = tempfile::tempdir().expect("tmpdir");
        let handle = format!("test-{}", Uuid::new_v4());
        let args = SpawnArgs {
            program: "bash".into(),
            args: vec!["/c".into(), "echo".into(), "hello world".into()],
            cwd: None,
            env: None,
            install_root: root.path().to_string_lossy().into_owned(),
        };

        let (stdout, _stderr, exit, res) = run_to_completion(&handle, args);
        assert!(res.is_ok(), "run_process_impl failed: {:?}", res.err());

        let joined = stdout.join("\n");
        assert!(
            joined.contains("hello world"),
            "expected 'hello world' in stdout, got: {joined:?}"
        );

        let exit_info = *exit.lock().unwrap();
        assert_eq!(exit_info, Some((Some(0), true)), "expected exit 0");
    }

    #[test]
    fn missing_command_returns_err_without_spawn() {
        let root = tempfile::tempdir().expect("tmpdir");
        let handle = format!("test-{}", Uuid::new_v4());
        let args = SpawnArgs {
            program: "bash".into(),
            args: vec![],
            cwd: None,
            env: None,
            install_root: root.path().to_string_lossy().into_owned(),
        };
        let (_, _, _, res) = run_to_completion(&handle, args);
        assert!(res.is_err());
        assert!(res.unwrap_err().contains("command not found"));
    }

    #[test]
    fn cancel_terminates_cmd_timeout_under_one_second() {
        let root = tempfile::tempdir().expect("tmpdir");
        let handle = format!("test-{}", Uuid::new_v4());
        let args = SpawnArgs {
            program: "bash".into(),
            args: vec![
                "/c".into(),
                "ping".into(),
                "-n".into(),
                "31".into(),
                "127.0.0.1".into(),
            ],
            cwd: None,
            env: None,
            install_root: root.path().to_string_lossy().into_owned(),
        };

        let handle_for_thread = handle.clone();
        let runner = std::thread::spawn(move || {
            let _ = run_process_impl(&handle_for_thread, &args, &test_path(), |_ev| {});
        });

        std::thread::sleep(Duration::from_millis(300));

        let start = Instant::now();
        let cancelled = cancel_process_impl(&handle, Duration::from_secs(0));
        assert!(
            cancelled,
            "cancel_process_impl should have found the handle"
        );

        runner.join().expect("runner thread should not panic");
        let elapsed = start.elapsed();

        assert!(
            elapsed < Duration::from_secs(1),
            "cancel took {elapsed:?} - expected <1s via TerminateJobObject"
        );
    }
}
