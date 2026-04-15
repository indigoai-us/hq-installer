//! GitHub cloud backend.
//!
//! The happy path:
//!
//! 1. `check_existing()` runs
//!    `gh repo view <spec> --json name,updatedAt,diskUsage` and parses
//!    the JSON response. `diskUsage` is in KB, so we multiply to bytes.
//! 2. `clone_to(target, force, sink)` streams `git clone` output through
//!    the progress sink line-by-line.
//!
//! Both operations depend on `gh` being installed — which US-003 already
//! guarantees as part of the dep check gate on the welcome screen. If
//! someone skips the dep install (`Skip (advanced)`), they'll hit a
//! `CloudError::ToolMissing { tool: "gh" }` and the GUI will loop them
//! back to install it.
//!
//! Tests inject a fake `CommandRunner` so we can exercise every response
//! shape (happy path, 404, auth failure, malformed JSON) without hitting
//! the network or needing `gh` on the dev machine.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Instant;

use async_trait::async_trait;
use serde::Deserialize;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

use super::{
    default_runner, target_is_clean, CloneProgress, CloneProgressSink, ClonedHqSummary,
    CloudBackend, CloudError, CommandRunner, ExistingInfo,
};

/// Default repo spec used when the user hasn't configured cloud sync yet.
/// The renderer fills this in once the user signs in via GitHub OAuth in
/// US-008, but for testing and dev we use `{{GITHUB_LOGIN}}/hq` as a
/// placeholder.
pub const DEFAULT_HQ_REPO_NAME: &str = "hq";

/// GitHub backend.
///
/// `repo_spec` is the `owner/repo` string that `gh` understands. The
/// runner is parameterized so tests can inject canned subprocess output.
#[derive(Debug)]
pub struct GithubBackend {
    repo_spec: String,
    runner: Arc<dyn CommandRunner>,
}

impl GithubBackend {
    /// Build a GitHub backend with the default tokio-backed runner.
    pub fn new(repo_spec: impl Into<String>) -> Self {
        Self {
            repo_spec: repo_spec.into(),
            runner: default_runner(),
        }
    }

    /// Build a GitHub backend with a custom runner. Used by tests to
    /// inject mocked subprocess output, and by the Tauri command layer
    /// if it ever needs to share a single runner across backends.
    pub fn with_runner(repo_spec: impl Into<String>, runner: Arc<dyn CommandRunner>) -> Self {
        Self {
            repo_spec: repo_spec.into(),
            runner,
        }
    }

    pub fn repo_spec(&self) -> &str {
        &self.repo_spec
    }
}

/// Shape of the JSON we ask `gh repo view` to emit. Extra fields are
/// tolerated by `serde(ignore_unknown)` semantics (serde_json ignores
/// unknown fields by default for structs without `deny_unknown_fields`).
#[derive(Debug, Deserialize)]
struct GhRepoView {
    #[serde(default)]
    name: Option<String>,
    #[serde(default, rename = "updatedAt")]
    updated_at: Option<String>,
    /// `gh` reports this in kilobytes.
    #[serde(default, rename = "diskUsage")]
    disk_usage_kb: Option<u64>,
}

/// Parse the JSON output of `gh repo view --json name,updatedAt,diskUsage`
/// into an `ExistingInfo`. Extracted as a free function so unit tests can
/// hit the parser directly without needing any subprocess or runner.
pub fn parse_gh_repo_view(json: &str) -> Result<ExistingInfo, CloudError> {
    let view: GhRepoView = serde_json::from_str(json).map_err(|e| CloudError::ParseError {
        message: format!("gh repo view JSON: {e}"),
    })?;

    // If `name` is populated, `gh` confirmed the repo exists — even an
    // empty repo returns a name. We treat missing `name` as "does not
    // exist" defensively (shouldn't happen on a successful response).
    let exists = view.name.is_some();
    let estimated_size = view.disk_usage_kb.map(|kb| kb.saturating_mul(1024));

    Ok(ExistingInfo {
        exists,
        last_modified: view.updated_at,
        estimated_size,
    })
}

/// Best-effort classifier for `gh repo view` exit failures.
///
/// `gh` uses exit code 1 for both "repo not found" and "auth failed",
/// so we fall back to scanning stderr for known strings. This keeps the
/// mapping in one place so the GUI can render the right modal.
fn classify_gh_view_failure(status: i32, stderr: &str) -> CloudError {
    let lower = stderr.to_ascii_lowercase();
    if lower.contains("could not resolve to a repository")
        || lower.contains("not found")
        || lower.contains("404")
    {
        CloudError::NotFound {
            what: "github repo".to_string(),
        }
    } else if lower.contains("authentication") || lower.contains("not logged in") {
        CloudError::AuthFailed {
            backend: "github".to_string(),
            message: stderr.trim().to_string(),
        }
    } else if status == 127 {
        CloudError::ToolMissing {
            tool: "gh".to_string(),
        }
    } else {
        CloudError::NetworkFailed {
            backend: "github".to_string(),
            message: stderr.trim().to_string(),
        }
    }
}

#[async_trait]
impl CloudBackend for GithubBackend {
    async fn check_existing(&self) -> Result<ExistingInfo, CloudError> {
        let out = self
            .runner
            .run(
                "gh",
                &[
                    "repo",
                    "view",
                    &self.repo_spec,
                    "--json",
                    "name,updatedAt,diskUsage",
                ],
            )
            .await?;

        if !out.ok() {
            let err = classify_gh_view_failure(out.status, &out.stderr);
            // `NotFound` is the happy "there's nothing here yet" path —
            // surface it as `exists: false` instead of a propagated error.
            if matches!(err, CloudError::NotFound { .. }) {
                return Ok(ExistingInfo::not_found());
            }
            return Err(err);
        }

        parse_gh_repo_view(&out.stdout)
    }

    async fn clone_to(
        &self,
        target_dir: &Path,
        force: bool,
        sink: &dyn CloneProgressSink,
    ) -> Result<ClonedHqSummary, CloudError> {
        if !force && !target_is_clean(target_dir)? {
            return Err(CloudError::TargetNotEmpty {
                path: target_dir.display().to_string(),
            });
        }
        if let Some(parent) = target_dir.parent() {
            if !parent.as_os_str().is_empty() {
                std::fs::create_dir_all(parent).map_err(|e| CloudError::Io {
                    message: format!("mkdir {}: {e}", parent.display()),
                })?;
            }
        }

        let source = self.repo_spec.clone();
        sink.emit(CloneProgress::Started {
            backend: self.name().to_string(),
            source: source.clone(),
        });

        // `gh repo clone` is the ergonomic path — it hands off to the
        // user's authenticated git under the hood and picks the right
        // URL (HTTPS vs SSH) based on their config. Streaming stderr
        // (git's progress channel) gives us live events.
        let duration_ms = run_streaming_clone(
            "gh",
            &[
                "repo",
                "clone",
                &source,
                target_dir
                    .to_str()
                    .ok_or_else(|| CloudError::Io {
                        message: format!("target path not UTF-8: {}", target_dir.display()),
                    })?,
            ],
            sink,
        )
        .await?;

        Ok(ClonedHqSummary {
            target_dir: PathBuf::from(target_dir),
            backend: self.name().to_string(),
            duration_ms,
        })
    }

    fn name(&self) -> &'static str {
        "github"
    }
}

/// Run a streaming clone-like command, emitting each stdout/stderr line
/// as a `CloneProgress::Streaming` event and the total duration as
/// `Completed` when the child exits cleanly. Returns the elapsed
/// duration in milliseconds on success.
///
/// Split into a free function so:
///   - The S3 backend can call it too (just with `git clone` directly)
///     once S3 lands as a real network backend.
///   - Integration tests in `src-tauri/tests/` can exercise the full
///     streaming path against a local bare git repo (via `git clone
///     file://…`) without needing `gh` or the network.
///
/// Note: reads stdout to EOF then stderr to EOF. `git clone` writes all
/// progress to stderr and leaves stdout empty, so stdout's reader hits
/// EOF immediately after spawn. No deadlock risk on either pipe because
/// neither exceeds the OS pipe buffer before the consumer drains it.
pub async fn run_streaming_clone(
    cmd: &str,
    args: &[&str],
    sink: &dyn CloneProgressSink,
) -> Result<u64, CloudError> {
    let start = Instant::now();

    let mut child = Command::new(cmd)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                CloudError::ToolMissing {
                    tool: cmd.to_string(),
                }
            } else {
                CloudError::Io {
                    message: format!("spawn {cmd}: {e}"),
                }
            }
        })?;

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    let mut stdout_lines: Vec<String> = Vec::new();
    let mut stderr_lines: Vec<String> = Vec::new();

    if let Some(out) = stdout {
        let mut reader = BufReader::new(out).lines();
        while let Some(line) = reader
            .next_line()
            .await
            .map_err(|e| CloudError::Io {
                message: format!("clone stdout: {e}"),
            })?
        {
            sink.emit(CloneProgress::Streaming { line: line.clone() });
            stdout_lines.push(line);
        }
    }
    if let Some(err) = stderr {
        let mut reader = BufReader::new(err).lines();
        while let Some(line) = reader
            .next_line()
            .await
            .map_err(|e| CloudError::Io {
                message: format!("clone stderr: {e}"),
            })?
        {
            sink.emit(CloneProgress::Streaming { line: line.clone() });
            stderr_lines.push(line);
        }
    }

    let status = child.wait().await.map_err(|e| CloudError::Io {
        message: format!("wait {cmd}: {e}"),
    })?;

    let duration_ms = start.elapsed().as_millis() as u64;

    if !status.success() {
        let msg = if !stderr_lines.is_empty() {
            stderr_lines.join("\n")
        } else {
            stdout_lines.join("\n")
        };
        sink.emit(CloneProgress::Error {
            message: msg.clone(),
        });
        return Err(CloudError::NetworkFailed {
            backend: cmd.to_string(),
            message: msg,
        });
    }

    sink.emit(CloneProgress::Completed { duration_ms });
    Ok(duration_ms)
}

// ──────────────────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    /// Stub runner that matches incoming `(cmd, args)` against a scripted
    /// queue and returns the matching `CommandOutput`. Fails the test
    /// loudly if we run out of scripted responses.
    #[derive(Debug)]
    struct StubRunner {
        expected: Mutex<Vec<StubCall>>,
    }

    #[derive(Debug)]
    struct StubCall {
        #[allow(dead_code)]
        description: &'static str,
        response: super::super::CommandOutput,
    }

    impl StubRunner {
        fn new(calls: Vec<StubCall>) -> Self {
            Self {
                expected: Mutex::new(calls),
            }
        }
    }

    #[async_trait]
    impl CommandRunner for StubRunner {
        async fn run(
            &self,
            _cmd: &str,
            _args: &[&str],
        ) -> Result<super::super::CommandOutput, CloudError> {
            let mut q = self.expected.lock().unwrap();
            if q.is_empty() {
                panic!("StubRunner called more times than scripted");
            }
            Ok(q.remove(0).response)
        }
    }

    fn ok(stdout: &str) -> super::super::CommandOutput {
        super::super::CommandOutput {
            status: 0,
            stdout: stdout.to_string(),
            stderr: String::new(),
        }
    }

    fn fail(status: i32, stderr: &str) -> super::super::CommandOutput {
        super::super::CommandOutput {
            status,
            stdout: String::new(),
            stderr: stderr.to_string(),
        }
    }

    #[test]
    fn parse_gh_repo_view_populates_fields() {
        let json = r#"{
            "name": "hq",
            "updatedAt": "2026-04-10T12:00:00Z",
            "diskUsage": 2048
        }"#;
        let info = parse_gh_repo_view(json).unwrap();
        assert!(info.exists);
        assert_eq!(
            info.last_modified.as_deref(),
            Some("2026-04-10T12:00:00Z")
        );
        // 2048 KB × 1024 = 2_097_152 bytes
        assert_eq!(info.estimated_size, Some(2_097_152));
    }

    #[test]
    fn parse_gh_repo_view_empty_name_treated_as_missing() {
        // Defensive: a malformed response with no `name` should not be
        // treated as "exists".
        let json = r#"{ "updatedAt": "2026-01-01T00:00:00Z" }"#;
        let info = parse_gh_repo_view(json).unwrap();
        assert!(!info.exists);
    }

    #[test]
    fn parse_gh_repo_view_rejects_invalid_json() {
        let err = parse_gh_repo_view("not json").unwrap_err();
        assert!(matches!(err, CloudError::ParseError { .. }));
    }

    #[test]
    fn parse_gh_repo_view_handles_missing_disk_usage() {
        // Private repos or very new repos sometimes omit diskUsage.
        let json = r#"{ "name": "hq", "updatedAt": "2026-01-01T00:00:00Z" }"#;
        let info = parse_gh_repo_view(json).unwrap();
        assert!(info.exists);
        assert!(info.estimated_size.is_none());
    }

    #[test]
    fn classify_gh_view_failure_matches_not_found() {
        let err = classify_gh_view_failure(
            1,
            "could not resolve to a Repository with the name 'foo/bar'",
        );
        assert!(matches!(err, CloudError::NotFound { .. }));
    }

    #[test]
    fn classify_gh_view_failure_matches_auth() {
        let err = classify_gh_view_failure(
            1,
            "authentication required — please run gh auth login",
        );
        assert!(matches!(err, CloudError::AuthFailed { .. }));
    }

    #[test]
    fn classify_gh_view_failure_defaults_to_network() {
        let err = classify_gh_view_failure(1, "some transient pipe error");
        assert!(matches!(err, CloudError::NetworkFailed { .. }));
    }

    #[test]
    fn classify_gh_view_failure_maps_127_to_tool_missing() {
        let err = classify_gh_view_failure(127, "");
        assert!(matches!(err, CloudError::ToolMissing { .. }));
    }

    #[tokio::test]
    async fn check_existing_with_stub_happy_path() {
        let runner = StubRunner::new(vec![StubCall {
            description: "gh repo view success",
            response: ok(r#"{"name":"hq","updatedAt":"2026-04-10T12:00:00Z","diskUsage":2048}"#),
        }]);
        let backend = GithubBackend::with_runner("owner/hq", Arc::new(runner));
        let info = backend.check_existing().await.unwrap();
        assert!(info.exists);
        assert_eq!(info.estimated_size, Some(2_097_152));
        assert_eq!(info.last_modified.unwrap(), "2026-04-10T12:00:00Z");
    }

    #[tokio::test]
    async fn check_existing_404_returns_not_found_shape() {
        let runner = StubRunner::new(vec![StubCall {
            description: "gh repo view not found",
            response: fail(1, "could not resolve to a repository with the name 'owner/hq'"),
        }]);
        let backend = GithubBackend::with_runner("owner/hq", Arc::new(runner));
        let info = backend.check_existing().await.unwrap();
        assert!(!info.exists);
        assert!(info.last_modified.is_none());
    }

    #[tokio::test]
    async fn check_existing_auth_failure_propagates() {
        let runner = StubRunner::new(vec![StubCall {
            description: "gh repo view auth fail",
            response: fail(1, "authentication required, please run gh auth login"),
        }]);
        let backend = GithubBackend::with_runner("owner/hq", Arc::new(runner));
        let err = backend.check_existing().await.unwrap_err();
        assert!(matches!(err, CloudError::AuthFailed { .. }));
    }

    #[tokio::test]
    async fn check_existing_parse_error_propagates() {
        let runner = StubRunner::new(vec![StubCall {
            description: "gh repo view garbage",
            response: ok("definitely not json"),
        }]);
        let backend = GithubBackend::with_runner("owner/hq", Arc::new(runner));
        let err = backend.check_existing().await.unwrap_err();
        assert!(matches!(err, CloudError::ParseError { .. }));
    }

    #[test]
    fn github_backend_name_is_stable() {
        let b = GithubBackend::new("owner/hq");
        assert_eq!(b.name(), "github");
        assert_eq!(b.repo_spec(), "owner/hq");
    }
}
