//! Streamed subprocess with cancellation.
//!
//! `spawn_process` — spawns a child, streams stdout as `process://{handle}/stdout`
//!                    events, emits `process://{handle}/exit` on termination.
//! `cancel_process` — sends SIGTERM to the process group; after 5 s, SIGKILL.

use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::os::unix::process::CommandExt as _;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::Duration;

use nix::sys::signal::{self, Signal};
use nix::unistd::Pid;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use uuid::Uuid;

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
    Exit { code: Option<i32>, success: bool },
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure impl
// ─────────────────────────────────────────────────────────────────────────────

/// Spawn the process described by `spawn`, update its registry entry with the
/// OS pid, stream stdout lines to `on_event`, then emit the exit event.
/// Blocks until the process exits.
///
/// The child is placed in its own process group so that cancellation can
/// signal the whole group (covers wrappers like `sh -c` or `npm run`).
///
/// All error paths reap the child and deregister the handle so no stale
/// registry entries or zombie processes are left behind.
pub fn run_process_impl<F>(handle: &str, spawn: &SpawnArgs, mut on_event: F) -> Result<(), String>
where
    F: FnMut(ProcessEvent),
{
    let mut cmd = Command::new(&spawn.cmd);
    cmd.args(&spawn.args)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        // Place the child in its own process group (pgid == child pid).
        // This lets cancel_process signal the whole group, not just the leader.
        .process_group(0);

    if let Some(cwd) = &spawn.cwd {
        cmd.current_dir(cwd);
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
    let mut stdout_err: Option<String> = None;
    for line_result in BufReader::new(stdout).lines() {
        match line_result {
            Ok(line) => on_event(ProcessEvent::Stdout(line)),
            Err(e) => {
                // Non-UTF-8 or I/O error — record and stop reading, but still
                // reap the child below.
                stdout_err = Some(e.to_string());
                break;
            }
        }
    }

    // Always reap and deregister, even when stdout produced an error.
    let wait_result = child.wait().map_err(|e| e.to_string());
    deregister_process(handle);

    if let Some(err) = stdout_err {
        on_event(ProcessEvent::Exit {
            code: None,
            success: false,
        });
        return Err(err);
    }

    let status = wait_result?;
    on_event(ProcessEvent::Exit {
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
#[tauri::command]
pub fn spawn_process(app: AppHandle, args: SpawnArgs) -> Result<String, String> {
    let handle = Uuid::new_v4().to_string();

    // Pre-register before the thread starts to eliminate the cancel race.
    pre_register_handle(&handle);

    let handle_bg = handle.clone();
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

        let result = run_process_impl(&handle_bg, &args, |event| match event {
            ProcessEvent::Stdout(line) => {
                let _ = app.emit(
                    &format!("process://{}/stdout", handle_bg),
                    StdoutEvent { line },
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
