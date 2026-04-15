//! Async shell command runner with line-by-line event streaming.
//!
//! Used by `commands::deps::install_dep` to execute an install command
//! and pipe its stdout/stderr to the renderer in real time. The renderer
//! subscribes to Tauri events and renders them in the "install logs"
//! terminal-style pane during the wizard's dependency step.
//!
//! ## Design
//!
//! - `RunEvent` is the serializable event payload (stdout line, stderr line,
//!   exit code, or error).
//! - `run_streaming` is the pure async entry point — it takes a sink closure
//!   `F: Fn(RunEvent)` instead of an `AppHandle`, so unit tests can collect
//!   events into a Vec without needing a Tauri runtime.
//! - `run_streaming_to_app` is the Tauri-flavored wrapper that forwards
//!   events to `app.emit(event_name, payload)`. The command-layer code
//!   (`commands::deps`) uses this variant.
//!
//! This split keeps the side-effecting shell machinery testable.

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

/// One line of output (or a terminal status) from a shell command.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum RunEvent {
    /// A line was read from stdout.
    Stdout { line: String },
    /// A line was read from stderr.
    Stderr { line: String },
    /// The process exited. `code` is `None` if killed by a signal.
    Exit { code: Option<i32> },
    /// The runner itself errored before the process completed (spawn
    /// failure, IO error on a pipe, etc.).
    Error { message: String },
}

/// Run a shell command, streaming stdout/stderr line-by-line through `sink`.
///
/// Returns the process exit code, or `None` if the process was killed by
/// a signal or the runner itself errored before spawn. Always emits a
/// terminal `RunEvent::Exit` or `RunEvent::Error` as the final event.
///
/// `command` is parsed with naive whitespace splitting — good enough for
/// the registry strings (`brew install gh`, `npm install -g qmd`, etc.)
/// but does not handle quoted arguments or shell meta-characters.
pub async fn run_streaming<F>(command: &str, sink: F) -> Option<i32>
where
    F: Fn(RunEvent) + Send + 'static + Clone,
{
    let parts: Vec<String> = command.split_whitespace().map(|s| s.to_string()).collect();
    let (program, args) = match parts.split_first() {
        Some((p, a)) => (p.clone(), a.to_vec()),
        None => {
            sink(RunEvent::Error {
                message: "empty command".to_string(),
            });
            return None;
        }
    };

    let mut child = match Command::new(&program)
        .args(&args)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
    {
        Ok(c) => c,
        Err(e) => {
            sink(RunEvent::Error {
                message: format!("spawn failed: {e}"),
            });
            return None;
        }
    };

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    let stdout_sink = sink.clone();
    let stdout_task = tokio::spawn(async move {
        if let Some(out) = stdout {
            let mut lines = BufReader::new(out).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                stdout_sink(RunEvent::Stdout { line });
            }
        }
    });

    let stderr_sink = sink.clone();
    let stderr_task = tokio::spawn(async move {
        if let Some(err) = stderr {
            let mut lines = BufReader::new(err).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                stderr_sink(RunEvent::Stderr { line });
            }
        }
    });

    let status = child.wait().await;
    let _ = stdout_task.await;
    let _ = stderr_task.await;

    match status {
        Ok(s) => {
            let code = s.code();
            sink(RunEvent::Exit { code });
            code
        }
        Err(e) => {
            sink(RunEvent::Error {
                message: format!("wait failed: {e}"),
            });
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    fn collect_sink() -> (Arc<Mutex<Vec<RunEvent>>>, impl Fn(RunEvent) + Send + Clone + 'static)
    {
        let buf = Arc::new(Mutex::new(Vec::new()));
        let buf_clone = buf.clone();
        let sink = move |ev: RunEvent| {
            buf_clone.lock().unwrap().push(ev);
        };
        (buf, sink)
    }

    #[tokio::test]
    async fn empty_command_emits_error() {
        let (buf, sink) = collect_sink();
        let code = run_streaming("", sink).await;
        assert_eq!(code, None);
        let events = buf.lock().unwrap();
        assert_eq!(events.len(), 1);
        assert!(matches!(events[0], RunEvent::Error { .. }));
    }

    #[tokio::test]
    async fn nonexistent_binary_emits_spawn_error() {
        let (buf, sink) = collect_sink();
        let code = run_streaming("definitely-not-a-real-binary-zzz", sink).await;
        assert_eq!(code, None);
        let events = buf.lock().unwrap();
        assert!(matches!(events.last(), Some(RunEvent::Error { .. })));
    }

    #[tokio::test]
    async fn echo_streams_stdout_and_exits_zero() {
        let (buf, sink) = collect_sink();
        // `echo hello world` — cross-platform (macOS, Linux have /bin/echo)
        let code = run_streaming("echo hello world", sink).await;
        assert_eq!(code, Some(0));
        let events = buf.lock().unwrap();
        // Should have at least one stdout event with "hello world"
        let stdout_lines: Vec<&String> = events
            .iter()
            .filter_map(|e| match e {
                RunEvent::Stdout { line } => Some(line),
                _ => None,
            })
            .collect();
        assert!(stdout_lines.iter().any(|l| l.contains("hello world")));
        // Final event must be Exit { code: Some(0) }
        assert!(matches!(events.last(), Some(RunEvent::Exit { code: Some(0) })));
    }

    #[tokio::test]
    async fn false_exits_nonzero() {
        let (buf, sink) = collect_sink();
        // `false` is a standard Unix no-op that exits 1
        let code = run_streaming("false", sink).await;
        // On macOS/Linux `false` exits 1
        assert!(matches!(code, Some(c) if c != 0));
        let events = buf.lock().unwrap();
        assert!(matches!(events.last(), Some(RunEvent::Exit { code: Some(_) })));
    }

    #[tokio::test]
    async fn run_event_serializes_with_kebab_case_type_tag() {
        let ev = RunEvent::Stdout {
            line: "installing…".to_string(),
        };
        let json = serde_json::to_string(&ev).unwrap();
        assert!(json.contains(r#""type":"stdout""#));
        assert!(json.contains(r#""line":"installing…""#));

        let ev = RunEvent::Exit { code: Some(0) };
        let json = serde_json::to_string(&ev).unwrap();
        assert!(json.contains(r#""type":"exit""#));
        assert!(json.contains(r#""code":0"#));
    }
}
