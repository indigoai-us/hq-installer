//! Cloud sync detection + clone core.
//!
//! Contract (see `docs/hq-install-spec.md` §5.3 + §5.7):
//!
//! Before writing any files to the local target, the installer asks every
//! configured cloud backend whether an HQ already lives there. If one does,
//! the renderer presents a three-way choice:
//!
//!   1. **Clone existing** — pull the remote HQ to the new machine
//!   2. **Start fresh + archive remote** — write the template, archive the
//!      old HQ under a timestamped tag/prefix
//!   3. **Cancel** — bail out and let the user sort it out manually
//!
//! This module defines the backend-agnostic surface that those choices act
//! on. Concrete implementations live under `core/cloud/`:
//!
//!   - `core/cloud/github.rs` — `gh` CLI-based GitHub backend
//!   - `core/cloud/s3.rs`     — `aws` CLI-based S3 backend (TODO: migrate
//!     to a native S3 crate once the dep tree is acceptable — see the
//!     comment at the top of `s3.rs` for the migration plan)
//!
//! Both backends can be exercised in tests via the `CommandRunner` trait,
//! which captures every subprocess invocation behind a mockable interface.
//! The production runner (`TokioRunner`) uses `tokio::process::Command`.

pub mod github;
pub mod s3;

use std::fmt;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};

// ──────────────────────────────────────────────────────────────────────────
// Shared types
// ──────────────────────────────────────────────────────────────────────────

/// Metadata about an existing cloud HQ discovered by `check_existing()`.
///
/// `last_modified` is an ISO-8601 string rather than a `DateTime` type so
/// the renderer can display it without any additional serde plumbing.
/// `estimated_size` is in bytes when available.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExistingInfo {
    pub exists: bool,
    pub last_modified: Option<String>,
    pub estimated_size: Option<u64>,
}

impl ExistingInfo {
    /// Helper for the "no HQ here" case.
    pub fn not_found() -> Self {
        Self {
            exists: false,
            last_modified: None,
            estimated_size: None,
        }
    }
}

/// Summary returned after a successful clone.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ClonedHqSummary {
    pub target_dir: PathBuf,
    pub backend: String,
    pub duration_ms: u64,
}

/// Progress events emitted by `clone_to` as the clone runs.
///
/// The renderer subscribes to these via a Tauri channel (see
/// `commands::cloud::clone_cloud_existing`) and updates a progress bar +
/// live log panel as each event arrives.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum CloneProgress {
    Started {
        backend: String,
        source: String,
    },
    /// A single line of tool output (e.g. `git clone` stderr). The log
    /// panel renders these as they arrive.
    Streaming {
        line: String,
    },
    Completed {
        duration_ms: u64,
    },
    Error {
        message: String,
    },
}

/// All the ways a cloud operation can fail, categorized for the renderer.
///
/// Each variant carries a stable `kind` discriminator via serde so the GUI
/// can route to the right modal without parsing free-text messages.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum CloudError {
    /// No HQ was found at the requested location — not necessarily a failure
    /// (it's the happy path for first-time users), but surfaced so callers
    /// that _expected_ a remote can react.
    NotFound { what: String },
    /// The backend refused our credentials. The GUI should push the user
    /// back to the auth step.
    AuthFailed { backend: String, message: String },
    /// Transient network failure. The GUI should offer a Retry button.
    NetworkFailed { backend: String, message: String },
    /// The external CLI this backend depends on isn't on PATH. The GUI
    /// should explain which tool is missing and how to install it.
    ToolMissing { tool: String },
    /// The backend returned JSON/text we couldn't parse — shouldn't happen
    /// in practice but worth surfacing for debugging.
    ParseError { message: String },
    /// Clone target directory was non-empty and the caller didn't pass
    /// `force=true`.
    TargetNotEmpty { path: String },
    /// Generic I/O failure.
    Io { message: String },
    /// Backend exists in the trait surface but isn't wired up yet — used
    /// only during development.
    NotImplemented { backend: String },
}

impl fmt::Display for CloudError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NotFound { what } => write!(f, "not found: {what}"),
            Self::AuthFailed { backend, message } => {
                write!(f, "{backend} auth failed: {message}")
            }
            Self::NetworkFailed { backend, message } => {
                write!(f, "{backend} network error: {message}")
            }
            Self::ToolMissing { tool } => {
                write!(f, "required tool `{tool}` not found on PATH")
            }
            Self::ParseError { message } => write!(f, "parse error: {message}"),
            Self::TargetNotEmpty { path } => {
                write!(f, "target directory is not empty: {path}")
            }
            Self::Io { message } => write!(f, "i/o error: {message}"),
            Self::NotImplemented { backend } => {
                write!(f, "{backend} backend not implemented yet")
            }
        }
    }
}

impl std::error::Error for CloudError {}

// ──────────────────────────────────────────────────────────────────────────
// CloneProgressSink — backend → caller progress channel
// ──────────────────────────────────────────────────────────────────────────

/// Sync callback used by async clone implementations to stream progress
/// back to the caller.
///
/// Implementations must be `Send + Sync` so they can be held across
/// `.await` boundaries and passed between threads. Most callers will use
/// a plain closure; the blanket impl below picks those up automatically.
pub trait CloneProgressSink: Send + Sync {
    fn emit(&self, event: CloneProgress);
}

impl<F> CloneProgressSink for F
where
    F: Fn(CloneProgress) + Send + Sync,
{
    fn emit(&self, event: CloneProgress) {
        self(event)
    }
}

// ──────────────────────────────────────────────────────────────────────────
// CommandRunner — subprocess abstraction for test injection
// ──────────────────────────────────────────────────────────────────────────

/// Captured result of running an external command.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandOutput {
    pub status: i32,
    pub stdout: String,
    pub stderr: String,
}

impl CommandOutput {
    pub fn ok(&self) -> bool {
        self.status == 0
    }
}

/// Runs external commands and returns captured output.
///
/// Production uses [`TokioRunner`]; tests inject a `StubRunner` (see
/// `core::cloud::github::tests`) to return canned responses without ever
/// touching a real subprocess.
#[async_trait]
pub trait CommandRunner: Send + Sync + fmt::Debug {
    async fn run(&self, cmd: &str, args: &[&str]) -> Result<CommandOutput, CloudError>;
}

/// Default production runner backed by `tokio::process::Command`.
///
/// If the command isn't on PATH (spawn returns `ErrorKind::NotFound`) the
/// runner maps that to `CloudError::ToolMissing` so the renderer can show
/// a specific "Install `gh` first" hint instead of a generic I/O error.
#[derive(Debug, Default)]
pub struct TokioRunner;

#[async_trait]
impl CommandRunner for TokioRunner {
    async fn run(&self, cmd: &str, args: &[&str]) -> Result<CommandOutput, CloudError> {
        let out = tokio::process::Command::new(cmd)
            .args(args)
            .output()
            .await
            .map_err(|e| {
                if e.kind() == std::io::ErrorKind::NotFound {
                    CloudError::ToolMissing {
                        tool: cmd.to_string(),
                    }
                } else {
                    CloudError::Io {
                        message: e.to_string(),
                    }
                }
            })?;
        Ok(CommandOutput {
            status: out.status.code().unwrap_or(-1),
            stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
        })
    }
}

/// Convenience factory — returns a shared runner backed by tokio.
pub fn default_runner() -> Arc<dyn CommandRunner> {
    Arc::new(TokioRunner)
}

// ──────────────────────────────────────────────────────────────────────────
// CloudBackend trait
// ──────────────────────────────────────────────────────────────────────────

/// A backend-agnostic interface for the "is there an HQ already in the
/// cloud?" question and its follow-up clone.
///
/// The trait is deliberately small — two async methods plus a display
/// name. Callers that need to dispatch between GitHub and S3 at runtime
/// (e.g. the Tauri command layer) hold a `Box<dyn CloudBackend>` and let
/// `async_trait` handle the virtual calls.
#[async_trait]
pub trait CloudBackend: Send + Sync + fmt::Debug {
    /// Check whether an HQ already exists at this backend's configured
    /// destination.
    ///
    /// Returns `Ok(ExistingInfo { exists: false, .. })` for the "no HQ
    /// here" case (NOT an `Err(NotFound)`) so the GUI can treat "checked
    /// and found nothing" distinctly from "failed to check".
    async fn check_existing(&self) -> Result<ExistingInfo, CloudError>;

    /// Clone the existing HQ from this backend into `target_dir`.
    ///
    /// Progress events are emitted through `sink` — typically a closure
    /// that forwards to a Tauri channel.
    ///
    /// Refuses to overwrite a non-empty target unless `force == true`.
    async fn clone_to(
        &self,
        target_dir: &Path,
        force: bool,
        sink: &dyn CloneProgressSink,
    ) -> Result<ClonedHqSummary, CloudError>;

    /// Short display name for events/logs (e.g. `"github"`, `"s3"`).
    fn name(&self) -> &'static str;
}

// ──────────────────────────────────────────────────────────────────────────
// Helpers shared by backends
// ──────────────────────────────────────────────────────────────────────────

/// Returns `true` if `target` is missing or exists and is empty.
///
/// Used by every backend's `clone_to` to refuse non-empty targets unless
/// the caller explicitly passed `force=true`. Mirrors the same helper in
/// `core::scaffold` — both are guarding against the same "don't clobber
/// user files" failure mode.
pub fn target_is_clean(target: &Path) -> Result<bool, CloudError> {
    if !target.exists() {
        return Ok(true);
    }
    let mut it = std::fs::read_dir(target).map_err(|e| CloudError::Io {
        message: format!("read_dir {}: {e}", target.display()),
    })?;
    Ok(it.next().is_none())
}

// ──────────────────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    #[test]
    fn existing_info_not_found_shape() {
        let info = ExistingInfo::not_found();
        assert!(!info.exists);
        assert!(info.last_modified.is_none());
        assert!(info.estimated_size.is_none());
    }

    #[test]
    fn existing_info_roundtrips_as_json() {
        let info = ExistingInfo {
            exists: true,
            last_modified: Some("2026-04-14T21:00:00Z".to_string()),
            estimated_size: Some(1_234_567),
        };
        let json = serde_json::to_string(&info).unwrap();
        let back: ExistingInfo = serde_json::from_str(&json).unwrap();
        assert_eq!(info, back);
        // Key names are snake_case on the wire.
        assert!(json.contains("last_modified"));
        assert!(json.contains("estimated_size"));
    }

    #[test]
    fn clone_progress_serde_tagged_kebab() {
        let ev = CloneProgress::Started {
            backend: "github".to_string(),
            source: "johnsonfamily1234/hq".to_string(),
        };
        let json = serde_json::to_string(&ev).unwrap();
        // The serde tag is "type" with kebab-case values.
        assert!(json.contains("\"type\":\"started\""));

        let streaming = CloneProgress::Streaming {
            line: "Receiving objects: 100%".into(),
        };
        let json = serde_json::to_string(&streaming).unwrap();
        assert!(json.contains("\"type\":\"streaming\""));
    }

    #[test]
    fn cloud_error_display_formats() {
        let e = CloudError::NotFound {
            what: "github repo".into(),
        };
        assert!(format!("{e}").contains("not found"));

        let e = CloudError::ToolMissing {
            tool: "gh".into(),
        };
        assert!(format!("{e}").contains("`gh`"));

        let e = CloudError::AuthFailed {
            backend: "s3".into(),
            message: "bad creds".into(),
        };
        assert!(format!("{e}").contains("s3 auth failed"));
    }

    #[test]
    fn cloud_error_serde_tag_is_kind() {
        let e = CloudError::ToolMissing {
            tool: "gh".into(),
        };
        let json = serde_json::to_string(&e).unwrap();
        assert!(json.contains("\"kind\":\"tool-missing\""));
    }

    #[test]
    fn target_is_clean_missing_dir() {
        let path = Path::new("/tmp/hq-installer-cloud-missing-xyz-12345");
        if !path.exists() {
            assert!(target_is_clean(path).unwrap());
        }
    }

    #[test]
    fn target_is_clean_empty_dir() {
        let tmp = tempfile::tempdir().unwrap();
        // A fresh tempdir starts empty.
        assert!(target_is_clean(tmp.path()).unwrap());
    }

    #[test]
    fn target_is_clean_non_empty_dir() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("sentinel"), b"hi").unwrap();
        assert!(!target_is_clean(tmp.path()).unwrap());
    }

    /// Closures implement `CloneProgressSink` automatically via the blanket
    /// impl, but that's easy to regress — this test pins it.
    #[test]
    fn closures_satisfy_progress_sink() {
        let events: Arc<Mutex<Vec<CloneProgress>>> = Arc::new(Mutex::new(Vec::new()));
        let captured = events.clone();
        let sink = move |ev: CloneProgress| {
            captured.lock().unwrap().push(ev);
        };

        fn take_sink(sink: &dyn CloneProgressSink) {
            sink.emit(CloneProgress::Started {
                backend: "test".into(),
                source: "spec".into(),
            });
        }

        take_sink(&sink);
        let got = events.lock().unwrap();
        assert_eq!(got.len(), 1);
        assert!(matches!(got[0], CloneProgress::Started { .. }));
    }
}
