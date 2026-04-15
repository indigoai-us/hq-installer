//! Tauri invoke commands for cloud HQ detection + clone.
//!
//! See `docs/hq-install-spec.md` §5.3 + §5.7. The renderer calls:
//!
//! 1. `check_cloud_existing(spec)` — returns an `ExistingInfo` for the
//!    configured backend. This is the "is there already an HQ here?"
//!    question the location picker needs to decide between "fresh
//!    scaffold", "clone existing", and "start fresh + archive".
//! 2. `clone_cloud_existing(spec, target_dir, force, request_id)` — runs
//!    the clone and streams progress events on the `cloud-clone:<id>`
//!    channel so the renderer can show a live log panel.
//!
//! Both commands dispatch on `CloudBackendSpec` — a tagged union the
//! renderer builds from the user's location picker choice. New backends
//! slot in by adding a variant here plus a module under `core::cloud/`.
//!
//! Error shape matches `commands::scaffold`: a kebab-case `kind` the GUI
//! can pattern-match plus a human-readable `message` for the modal body.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use crate::core::cloud::{
    self, CloneProgress, CloneProgressSink, ClonedHqSummary, CloudBackend, CloudError,
    ExistingInfo,
};

// ──────────────────────────────────────────────────────────────────────────
// Renderer-facing spec + outcome shapes
// ──────────────────────────────────────────────────────────────────────────

/// Discriminated union the renderer uses to pick a backend.
///
/// Kebab-case on the wire so the renderer can build it with
/// `{ backend: "github", repo: "owner/hq" }` — the same shape the
/// location picker already collects in US-008.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "backend", rename_all = "kebab-case")]
pub enum CloudBackendSpec {
    Github { repo: String },
    S3 { bucket: String, prefix: String },
}

impl CloudBackendSpec {
    /// Instantiate the right core backend for this spec. Returns a boxed
    /// trait object so the call sites can work polymorphically without
    /// caring which variant was chosen.
    fn into_backend(self) -> Box<dyn CloudBackend> {
        match self {
            Self::Github { repo } => Box::new(cloud::github::GithubBackend::new(repo)),
            Self::S3 { bucket, prefix } => Box::new(cloud::s3::S3Backend::new(bucket, prefix)),
        }
    }
}

/// Renderer-visible `check_existing` outcome.
///
/// Matches the shape of `ScaffoldOutcome`: on `Ok` the caller gets the
/// info struct, on `Err` it gets a stable `kind` discriminator for modal
/// routing plus a human `message`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case", tag = "result")]
pub enum CheckCloudOutcome {
    Ok { info: ExistingInfo },
    Err { kind: CloudErrorKind, message: String },
}

/// Renderer-visible `clone_to` outcome.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case", tag = "result")]
pub enum CloneCloudOutcome {
    Ok { summary: ClonedHqSummary },
    Err { kind: CloudErrorKind, message: String },
}

/// Stable kebab-case discriminator for `CloudError` variants.
///
/// The GUI uses this to route to the right modal (auth-failed → send
/// user back to sign-in, tool-missing → show "install gh" hint, etc.)
/// without parsing stringified errors.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CloudErrorKind {
    NotFound,
    AuthFailed,
    NetworkFailed,
    ToolMissing,
    ParseError,
    TargetNotEmpty,
    Io,
    NotImplemented,
}

impl From<&CloudError> for CloudErrorKind {
    fn from(e: &CloudError) -> Self {
        match e {
            CloudError::NotFound { .. } => Self::NotFound,
            CloudError::AuthFailed { .. } => Self::AuthFailed,
            CloudError::NetworkFailed { .. } => Self::NetworkFailed,
            CloudError::ToolMissing { .. } => Self::ToolMissing,
            CloudError::ParseError { .. } => Self::ParseError,
            CloudError::TargetNotEmpty { .. } => Self::TargetNotEmpty,
            CloudError::Io { .. } => Self::Io,
            CloudError::NotImplemented { .. } => Self::NotImplemented,
        }
    }
}

// ──────────────────────────────────────────────────────────────────────────
// Commands
// ──────────────────────────────────────────────────────────────────────────

/// Ask the configured backend whether an HQ already exists at the remote
/// destination.
///
/// Returns quickly (single `gh`/`aws` call) — the renderer shows a
/// spinner while this runs but doesn't need event streaming because
/// there's only one subprocess invocation end-to-end.
#[tauri::command]
pub async fn check_cloud_existing(spec: CloudBackendSpec) -> CheckCloudOutcome {
    let backend = spec.into_backend();
    match backend.check_existing().await {
        Ok(info) => CheckCloudOutcome::Ok { info },
        Err(e) => {
            let kind = (&e).into();
            CheckCloudOutcome::Err {
                kind,
                message: e.to_string(),
            }
        }
    }
}

/// Event sink that forwards core `CloneProgress` events to the renderer
/// over a Tauri event channel. One sink per invocation — the `request_id`
/// namespaces the channel so the renderer can subscribe to exactly the
/// clone it started.
///
/// Emit errors are swallowed: the only way `emit` fails is during app
/// shutdown, at which point the clone is going to get torn down anyway.
struct TauriCloneSink {
    app: AppHandle,
    channel: String,
}

impl CloneProgressSink for TauriCloneSink {
    fn emit(&self, event: CloneProgress) {
        let _ = self.app.emit(&self.channel, event);
    }
}

/// Clone a remote HQ to `target_dir`, streaming progress events on the
/// `cloud-clone:<request_id>` channel.
///
/// The renderer:
///   1. Generates a request id (uuid, timestamp — anything unique).
///   2. Subscribes to `cloud-clone:<id>` via `listen()`.
///   3. Invokes this command and awaits the outcome.
///   4. Unlistens.
#[tauri::command]
pub async fn clone_cloud_existing(
    app: AppHandle,
    spec: CloudBackendSpec,
    target_dir: String,
    force: bool,
    request_id: String,
) -> CloneCloudOutcome {
    let backend = spec.into_backend();
    let target = PathBuf::from(target_dir);
    let sink = TauriCloneSink {
        app,
        channel: format!("cloud-clone:{request_id}"),
    };

    match backend.clone_to(&target, force, &sink).await {
        Ok(summary) => CloneCloudOutcome::Ok { summary },
        Err(e) => {
            let kind = (&e).into();
            CloneCloudOutcome::Err {
                kind,
                message: e.to_string(),
            }
        }
    }
}

// ──────────────────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cloud_backend_spec_github_serde_roundtrip() {
        let spec = CloudBackendSpec::Github {
            repo: "owner/hq".to_string(),
        };
        let json = serde_json::to_string(&spec).unwrap();
        // Tag is `backend`, kebab-case variant names.
        assert!(json.contains("\"backend\":\"github\""));
        assert!(json.contains("\"repo\":\"owner/hq\""));

        let back: CloudBackendSpec = serde_json::from_str(&json).unwrap();
        match back {
            CloudBackendSpec::Github { repo } => assert_eq!(repo, "owner/hq"),
            _ => panic!("wrong variant round-tripped"),
        }
    }

    #[test]
    fn cloud_backend_spec_s3_serde_roundtrip() {
        let spec = CloudBackendSpec::S3 {
            bucket: "indigo-hq".to_string(),
            prefix: "stefan-hq".to_string(),
        };
        let json = serde_json::to_string(&spec).unwrap();
        assert!(json.contains("\"backend\":\"s3\""));
        assert!(json.contains("\"bucket\":\"indigo-hq\""));
        assert!(json.contains("\"prefix\":\"stefan-hq\""));

        let back: CloudBackendSpec = serde_json::from_str(&json).unwrap();
        match back {
            CloudBackendSpec::S3 { bucket, prefix } => {
                assert_eq!(bucket, "indigo-hq");
                assert_eq!(prefix, "stefan-hq");
            }
            _ => panic!("wrong variant round-tripped"),
        }
    }

    #[test]
    fn cloud_error_kind_from_all_variants() {
        let cases: &[(CloudError, CloudErrorKind)] = &[
            (
                CloudError::NotFound {
                    what: "x".into(),
                },
                CloudErrorKind::NotFound,
            ),
            (
                CloudError::AuthFailed {
                    backend: "github".into(),
                    message: "x".into(),
                },
                CloudErrorKind::AuthFailed,
            ),
            (
                CloudError::NetworkFailed {
                    backend: "s3".into(),
                    message: "x".into(),
                },
                CloudErrorKind::NetworkFailed,
            ),
            (
                CloudError::ToolMissing { tool: "gh".into() },
                CloudErrorKind::ToolMissing,
            ),
            (
                CloudError::ParseError {
                    message: "x".into(),
                },
                CloudErrorKind::ParseError,
            ),
            (
                CloudError::TargetNotEmpty { path: "/x".into() },
                CloudErrorKind::TargetNotEmpty,
            ),
            (
                CloudError::Io {
                    message: "x".into(),
                },
                CloudErrorKind::Io,
            ),
            (
                CloudError::NotImplemented {
                    backend: "ftp".into(),
                },
                CloudErrorKind::NotImplemented,
            ),
        ];
        for (err, expected_kind) in cases {
            assert_eq!(CloudErrorKind::from(err), *expected_kind);
        }
    }

    #[test]
    fn cloud_error_kind_serde_is_kebab_case() {
        let k = CloudErrorKind::TargetNotEmpty;
        let json = serde_json::to_string(&k).unwrap();
        assert_eq!(json, "\"target-not-empty\"");

        let k = CloudErrorKind::AuthFailed;
        let json = serde_json::to_string(&k).unwrap();
        assert_eq!(json, "\"auth-failed\"");
    }

    #[test]
    fn check_cloud_outcome_ok_serde_shape() {
        let out = CheckCloudOutcome::Ok {
            info: ExistingInfo {
                exists: true,
                last_modified: Some("2026-04-10T12:00:00Z".into()),
                estimated_size: Some(1024),
            },
        };
        let json = serde_json::to_string(&out).unwrap();
        assert!(json.contains("\"result\":\"ok\""));
        assert!(json.contains("\"exists\":true"));
    }

    #[test]
    fn check_cloud_outcome_err_serde_shape() {
        let out = CheckCloudOutcome::Err {
            kind: CloudErrorKind::AuthFailed,
            message: "please run gh auth login".into(),
        };
        let json = serde_json::to_string(&out).unwrap();
        assert!(json.contains("\"result\":\"err\""));
        assert!(json.contains("\"kind\":\"auth-failed\""));
    }
}
