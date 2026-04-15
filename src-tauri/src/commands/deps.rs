//! Tauri invoke commands for dependency operations.
//!
//! Three entry points:
//!
//! - `dep_registry` — returns the frozen `Vec<DepDescriptor>` the renderer
//!   needs to render the dependency list before running any probes.
//! - `check_deps` — probes each dep and returns `Vec<CheckResult>`. Fast,
//!   synchronous, safe to call on every wizard step mount.
//! - `install_dep` — async install flow. Uses `plan_install` to decide
//!   between auto-install (streaming command output through
//!   `dep-install:<dep-id>` events) and manual (open browser to hint URL).
//!
//! The renderer subscribes to `dep-install:<dep-id>` Tauri events to get
//! live stdout/stderr + exit code. After install_dep resolves, the renderer
//! calls `check_deps` again to confirm the install stuck.

use crate::core::deps::{
    self, CheckResult, DepDescriptor, DepId, InstallAction,
};
use crate::core::platform;
use crate::core::runner::{self, RunEvent};

use tauri::{AppHandle, Emitter};

/// Return the full dep registry for the renderer to render.
#[tauri::command]
pub fn dep_registry() -> Vec<DepDescriptor> {
    deps::registry()
}

/// Probe every dep against the live environment.
#[tauri::command]
pub fn check_deps() -> Vec<CheckResult> {
    deps::check_all()
}

/// Outcome of an install attempt.
///
/// The `Auto` variant records the command that was run + its exit code.
/// The `Manual` variant records that we opened the browser (or would have).
/// The `NotFound` variant is returned when the caller passed an unknown id.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "kebab-case", tag = "result")]
pub enum InstallOutcome {
    Auto {
        command: String,
        exit_code: Option<i32>,
    },
    Manual {
        hint: String,
    },
    NotFound {
        dep_id: DepId,
    },
}

/// Install a single dep.
///
/// Streams live install output to the renderer via Tauri events on the
/// `dep-install:<dep-id>` channel. On manual deps (Node.js, git), the
/// renderer is expected to open the hint URL in the system browser — this
/// command just returns the `Manual` outcome so the renderer can react.
///
/// Returning `Auto { exit_code: Some(0) }` does not by itself mean the dep
/// is installed — the renderer should re-run `check_deps` after this
/// command resolves and look at the `installed` flag.
#[tauri::command]
pub async fn install_dep(app: AppHandle, dep_id: DepId) -> InstallOutcome {
    let dep = match deps::find(dep_id) {
        Some(d) => d,
        None => return InstallOutcome::NotFound { dep_id },
    };

    let platform_info = platform::detect_platform();
    let action = deps::plan_install(&dep, &platform_info);

    match action {
        InstallAction::Manual { hint } => InstallOutcome::Manual { hint },
        InstallAction::Auto { command } => {
            let channel = format!("dep-install:{}", serde_json::to_string(&dep_id).unwrap_or_default().trim_matches('"'));
            let app_for_sink = app.clone();
            let chan_for_sink = channel.clone();
            let sink = move |ev: RunEvent| {
                // Best-effort emit — ignore errors during shutdown.
                let _ = app_for_sink.emit(&chan_for_sink, ev);
            };
            let exit_code = runner::run_streaming(&command, sink).await;
            InstallOutcome::Auto {
                command,
                exit_code,
            }
        }
    }
}
