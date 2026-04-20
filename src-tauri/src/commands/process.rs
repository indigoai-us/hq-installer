//! Streamed subprocess with cancellation.
//!
//! `spawn_process` — spawns a child, streams stdout as `process://{handle}/stdout`
//!                    events, emits `process://{handle}/exit` on termination.
//! `cancel_process` — sends SIGTERM to the process group; after 5 s, SIGKILL.

use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::os::unix::process::CommandExt as _;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::Duration;

use nix::sys::signal::{self, Signal};
use nix::unistd::Pid;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use uuid::Uuid;

use super::deps::extended_search_path;

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/// Arguments for `spawn_process`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnArgs {
    pub cmd: String,
    pub args: Vec<String>,
    pub cwd: Option<String>,
    pub env: Option<HashMap<String, String>>,
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
                cancelled: false,
            },
        );
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

// ─────────────────────────────────────────────────────────────────────────────
// Event enum (testable without Tauri)
// ─────────────────────────────────────────────────────────────────────────────

/// Events emitted during process execution.
pub enum ProcessEvent {
    Stdout(String),
    Stderr(String),
    Exit { code: Option<i32>, success: bool },
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure impl
// ─────────────────────────────────────────────────────────────────────────────

/// Spawn the process described by `spawn`, update its registry entry with the
/// OS pid, stream stdout + stderr lines to `on_event`, then emit the exit
/// event.  Blocks until the process exits.
///
/// `search_path` is used to resolve bare command names (e.g. `qmd`, `npm`)
/// to absolute paths via `which::which_in` before spawning. GUI-launched
/// Tauri apps inherit only `/usr/bin:/bin` from LaunchServices, so passing
/// the caller's bare `cmd` directly to `Command::new` would fail to locate
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
pub fn run_process_impl<F>(
    handle: &str,
    spawn: &SpawnArgs,
    search_path: &str,
    on_event: F,
) -> Result<(), String>
where
    F: FnMut(ProcessEvent),
{
    // Resolve the cmd via the caller-supplied search path. `which_in` accepts
    // an absolute path too and returns it unchanged, so this is a no-op when
    // the caller passes a full path.
    let cwd_for_which: PathBuf = spawn
        .cwd
        .as_ref()
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_default());
    let resolved = which::which_in(&spawn.cmd, Some(search_path), cwd_for_which)
        .map_err(|_| format!("command not found on PATH: {}", spawn.cmd))?;

    let mut cmd = Command::new(&resolved);
    cmd.args(&spawn.args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        // Place the child in its own process group (pgid == child pid).
        // This lets cancel_process signal the whole group, not just the leader.
        .process_group(0);

    if let Some(cwd) = &spawn.cwd {
        cmd.current_dir(cwd);
    }

    // Seed the child's PATH from the search path so grandchildren inherit
    // the extended PATH. Caller's explicit PATH in `spawn.env` takes precedence.
    let caller_sets_path = spawn
        .env
        .as_ref()
        .map(|e| e.contains_key("PATH"))
        .unwrap_or(false);
    if !caller_sets_path {
        cmd.env("PATH", search_path);
    }
    if let Some(env) = &spawn.env {
        for (k, v) in env {
            cmd.env(k, v);
        }
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("spawn '{}': {}", spawn.cmd, e))?;

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
        Done { stream: &'static str, err: Option<String> },
    }

    let (tx, rx) = mpsc::channel::<ReaderMsg>();

    // stdout reader
    let tx_stdout = tx.clone();
    thread::spawn(move || {
        let mut err: Option<String> = None;
        for line_result in BufReader::new(stdout).lines() {
            match line_result {
                Ok(line) => {
                    if tx_stdout.send(ReaderMsg::Event(ProcessEvent::Stdout(line))).is_err() {
                        return;
                    }
                }
                Err(e) => {
                    err = Some(e.to_string());
                    break;
                }
            }
        }
        let _ = tx_stdout.send(ReaderMsg::Done { stream: "stdout", err });
    });

    // stderr reader
    let tx_stderr = tx.clone();
    thread::spawn(move || {
        let mut err: Option<String> = None;
        for line_result in BufReader::new(stderr).lines() {
            match line_result {
                Ok(line) => {
                    if tx_stderr.send(ReaderMsg::Event(ProcessEvent::Stderr(line))).is_err() {
                        return;
                    }
                }
                Err(e) => {
                    err = Some(e.to_string());
                    break;
                }
            }
        }
        let _ = tx_stderr.send(ReaderMsg::Done { stream: "stderr", err });
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
/// The command is resolved against the shell-derived extended PATH
/// *synchronously* before returning Ok(handle). If it can't be found, Err is
/// returned and no background thread is ever spawned — this matters because
/// the JS listener registration for `exit` happens after `await invoke()`
/// resolves, so an error event emitted from a background thread could race
/// past it and leave the UI stuck at "Running…".
#[tauri::command]
pub fn spawn_process(app: AppHandle, args: SpawnArgs) -> Result<String, String> {
    let search_path = extended_search_path();

    // Synchronous pre-resolution — if the binary isn't on the extended PATH,
    // fail before anyone subscribes to exit events. No race possible.
    let cwd_for_which: PathBuf = args
        .cwd
        .as_ref()
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_default());
    which::which_in(&args.cmd, Some(&search_path), cwd_for_which)
        .map_err(|_| format!("command not found on PATH: {}", args.cmd))?;

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

        if let Err(_e) = result {
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

/// Send SIGTERM to the process group, then SIGKILL after 5 s if still alive.
///
/// Returns `true` if the handle was registered (process existed),
/// `false` if the handle is unknown.
#[tauri::command]
pub fn cancel_process(handle: String) -> bool {
    cancel_process_impl(&handle, Duration::from_secs(5))
}
