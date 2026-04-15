//! Tauri invoke command for HQ template scaffolding.
//!
//! The renderer calls `scaffold_hq(target_dir, force)`; this wrapper runs
//! the core scaffold on a blocking task (file I/O + git subprocess) and
//! forwards every `ScaffoldEvent` to the renderer on the
//! `scaffold:<request-id>` channel.
//!
//! The renderer:
//! 1. Generates a request id (uuid or timestamp — free-form).
//! 2. Subscribes to `scaffold:<id>` via `listen()`.
//! 3. Invokes `scaffold_hq(...)` and awaits the summary.
//! 4. Unlistens.

use std::path::PathBuf;

use crate::core::scaffold::{self, ScaffoldError, ScaffoldEvent, ScaffoldSummary};

use tauri::{AppHandle, Emitter};

/// Renderer-visible scaffold outcome.
///
/// `Ok` carries the `ScaffoldSummary`; `Err` carries a renderer-friendly
/// error category + human message so the GUI can route to the right modal
/// (not-empty confirm, git-error alert, etc.) without parsing strings.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "kebab-case", tag = "result")]
pub enum ScaffoldOutcome {
    Ok {
        summary: ScaffoldSummary,
    },
    Err {
        kind: ScaffoldErrorKind,
        message: String,
    },
}

/// Stable categorization of `ScaffoldError` variants for the renderer.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ScaffoldErrorKind {
    TargetNotEmpty,
    TargetNotWritable,
    Io,
    GitFailed,
    EmbeddedTemplateEmpty,
    GitConfigMissing,
}

impl From<&ScaffoldError> for ScaffoldErrorKind {
    fn from(e: &ScaffoldError) -> Self {
        match e {
            ScaffoldError::TargetNotEmpty(_) => Self::TargetNotEmpty,
            ScaffoldError::TargetNotWritable(_, _) => Self::TargetNotWritable,
            ScaffoldError::Io(_) => Self::Io,
            ScaffoldError::GitInitFailed(_)
            | ScaffoldError::GitAddFailed(_)
            | ScaffoldError::GitCommitFailed(_) => Self::GitFailed,
            ScaffoldError::GitConfigMissing => Self::GitConfigMissing,
            ScaffoldError::EmbeddedTemplateEmpty => Self::EmbeddedTemplateEmpty,
        }
    }
}

/// Scaffold the embedded HQ template into `target_dir`.
///
/// The work runs on `spawn_blocking` because file I/O + git subprocess
/// calls would otherwise hold the tokio reactor. Progress events are
/// emitted on the `scaffold:<request_id>` channel so the renderer can
/// render a live progress bar.
#[tauri::command]
pub async fn scaffold_hq(
    app: AppHandle,
    target_dir: String,
    force: bool,
    request_id: String,
) -> ScaffoldOutcome {
    let target = PathBuf::from(target_dir);
    let channel = format!("scaffold:{request_id}");
    let app_for_sink = app.clone();
    let chan_for_sink = channel.clone();

    let sink = move |ev: ScaffoldEvent| {
        // Best-effort emit — ignore errors during shutdown.
        let _ = app_for_sink.emit(&chan_for_sink, ev);
    };

    // Run the sync scaffold on a blocking thread so we don't stall the
    // async runtime.
    let join = tokio::task::spawn_blocking(move || {
        scaffold::scaffold_hq(&target, force, sink)
    })
    .await;

    match join {
        Ok(Ok(summary)) => ScaffoldOutcome::Ok { summary },
        Ok(Err(e)) => {
            let kind = (&e).into();
            ScaffoldOutcome::Err {
                kind,
                message: e.to_string(),
            }
        }
        Err(join_err) => ScaffoldOutcome::Err {
            kind: ScaffoldErrorKind::Io,
            message: format!("scaffold task panicked: {join_err}"),
        },
    }
}

/// Return the embedded template file count without running the scaffold.
/// Useful for the renderer's pre-install confirmation screen.
#[tauri::command]
pub fn template_file_count() -> usize {
    scaffold::template_file_count()
}
