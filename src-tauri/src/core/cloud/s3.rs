//! S3 cloud backend.
//!
//! MVP implementation — wraps the `aws` CLI via the shared `CommandRunner`
//! abstraction so tests can stub subprocess output without touching real
//! AWS credentials. The spec (`docs/hq-install-spec.md` §5.3) calls out
//! S3 as one of two supported backends alongside GitHub.
//!
//! # Why `aws` CLI instead of a native crate
//!
//! The PRD hints at using the `s3` crate directly. Adding a native S3
//! client (either `aws-sdk-s3` or `rust-s3`) cascades ~30 transitive
//! dependencies and adds a noticeable amount to compile time. For this
//! first cut we reuse the same subprocess pattern as the GitHub backend
//! and require `aws` on PATH. US-008 (location picker) will surface the
//! "aws not installed" case the same way it surfaces the GitHub "gh not
//! installed" case.
//!
//! # Migration plan
//!
//! When this moves to native, the trait surface stays the same:
//!
//!   1. Replace `CommandRunner::run("aws", …)` calls with
//!      `aws_sdk_s3::Client` calls.
//!   2. Replace `run_streaming_clone("aws", …)` with a manual object-by-
//!      object iterator that reports progress per downloaded key.
//!   3. Leave the `ExistingInfo` / `ClonedHqSummary` shapes untouched —
//!      the renderer never sees the difference.
//!
//! Until then, `check_existing` wraps `aws s3 ls s3://<bucket>/<prefix>/`
//! and `clone_to` wraps `aws s3 sync s3://<bucket>/<prefix>/ <target>`.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;

use async_trait::async_trait;

use super::{
    default_runner, target_is_clean, CloneProgress, CloneProgressSink, ClonedHqSummary,
    CloudBackend, CloudError, CommandRunner, ExistingInfo,
};

/// S3 backend — configured with a bucket and an optional prefix (which
/// defaults to `hq/`). The runner is injected for test support.
#[derive(Debug)]
pub struct S3Backend {
    bucket: String,
    prefix: String,
    runner: Arc<dyn CommandRunner>,
}

impl S3Backend {
    /// Build an S3 backend with the default tokio-backed runner.
    pub fn new(bucket: impl Into<String>, prefix: impl Into<String>) -> Self {
        Self {
            bucket: bucket.into(),
            prefix: normalize_prefix(prefix.into()),
            runner: default_runner(),
        }
    }

    /// Build an S3 backend with a custom runner. Tests use this to inject
    /// `StubRunner` for scripted subprocess responses.
    pub fn with_runner(
        bucket: impl Into<String>,
        prefix: impl Into<String>,
        runner: Arc<dyn CommandRunner>,
    ) -> Self {
        Self {
            bucket: bucket.into(),
            prefix: normalize_prefix(prefix.into()),
            runner,
        }
    }

    pub fn bucket(&self) -> &str {
        &self.bucket
    }

    pub fn prefix(&self) -> &str {
        &self.prefix
    }

    /// The `s3://bucket/prefix/` URI that `aws s3` accepts.
    pub fn uri(&self) -> String {
        format!("s3://{}/{}", self.bucket, self.prefix)
    }
}

/// Ensure the prefix has a trailing `/` and no leading `/`. S3 keys are
/// slash-separated but not hierarchical, and `aws s3 ls` treats trailing
/// slashes as "list contents of this directory-like prefix".
fn normalize_prefix(mut p: String) -> String {
    while p.starts_with('/') {
        p.remove(0);
    }
    if !p.ends_with('/') {
        p.push('/');
    }
    p
}

/// Parse the `aws s3 ls` output into an `ExistingInfo`.
///
/// `aws s3 ls` emits one line per object:
///   `2024-04-01 12:34:56       1024 manifest.yaml`
/// and one line per subprefix:
///   `                           PRE .claude/`
///
/// We treat the HQ as "exists" if at least one object matches the
/// recognizable HQ signature file (`manifest.yaml` or `README.md`), and
/// we pull `last_modified` from the most recent timestamp seen. Size is
/// the sum of object sizes (which won't match recursive totals but is
/// close enough for the "estimated size" row in the UI).
pub fn parse_aws_s3_ls(stdout: &str) -> ExistingInfo {
    let mut latest_ts: Option<String> = None;
    let mut total_size: u64 = 0;
    let mut matched_signature = false;

    for line in stdout.lines() {
        // Prefix rows: "                           PRE .claude/"
        if line.trim_start().starts_with("PRE ") {
            continue;
        }
        // Object rows: "2024-04-01 12:34:56       1024 manifest.yaml"
        let mut it = line.split_whitespace();
        let date = it.next();
        let time = it.next();
        let size = it.next();
        let name: String = it.collect::<Vec<&str>>().join(" ");
        if name.is_empty() {
            continue;
        }
        if name == "manifest.yaml"
            || name.ends_with("/manifest.yaml")
            || name == "README.md"
            || name.ends_with("/README.md")
        {
            matched_signature = true;
        }
        if let Some(sz) = size.and_then(|s| s.parse::<u64>().ok()) {
            total_size += sz;
        }
        if let (Some(d), Some(t)) = (date, time) {
            // ISO-8601: "2024-04-01T12:34:56Z"
            let ts = format!("{d}T{t}Z");
            latest_ts = match latest_ts {
                None => Some(ts),
                Some(prev) => Some(if ts > prev { ts } else { prev }),
            };
        }
    }

    ExistingInfo {
        exists: matched_signature,
        last_modified: latest_ts,
        estimated_size: if total_size == 0 {
            None
        } else {
            Some(total_size)
        },
    }
}

/// Classify `aws s3 ls` failures into the right `CloudError` variant so
/// the renderer can route to the right modal.
fn classify_aws_ls_failure(status: i32, stderr: &str) -> CloudError {
    let lower = stderr.to_ascii_lowercase();
    if lower.contains("nosuchbucket") || lower.contains("not found") || lower.contains("404") {
        CloudError::NotFound {
            what: "s3 bucket/prefix".to_string(),
        }
    } else if lower.contains("credential")
        || lower.contains("access denied")
        || lower.contains("403")
    {
        CloudError::AuthFailed {
            backend: "s3".to_string(),
            message: stderr.trim().to_string(),
        }
    } else if status == 127 {
        CloudError::ToolMissing {
            tool: "aws".to_string(),
        }
    } else {
        CloudError::NetworkFailed {
            backend: "s3".to_string(),
            message: stderr.trim().to_string(),
        }
    }
}

#[async_trait]
impl CloudBackend for S3Backend {
    async fn check_existing(&self) -> Result<ExistingInfo, CloudError> {
        let uri = self.uri();
        let out = self
            .runner
            .run("aws", &["s3", "ls", &uri, "--recursive"])
            .await?;

        if !out.ok() {
            let err = classify_aws_ls_failure(out.status, &out.stderr);
            // NotFound is the happy "no cloud HQ here" path — mirror the
            // GitHub backend and return `exists: false` instead.
            if matches!(err, CloudError::NotFound { .. }) {
                return Ok(ExistingInfo::not_found());
            }
            return Err(err);
        }

        Ok(parse_aws_s3_ls(&out.stdout))
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
        std::fs::create_dir_all(target_dir).map_err(|e| CloudError::Io {
            message: format!("mkdir {}: {e}", target_dir.display()),
        })?;

        let source = self.uri();
        sink.emit(CloneProgress::Started {
            backend: self.name().to_string(),
            source: source.clone(),
        });

        let target_str = target_dir.to_str().ok_or_else(|| CloudError::Io {
            message: format!("target path not UTF-8: {}", target_dir.display()),
        })?;

        let start = Instant::now();
        let out = self
            .runner
            .run("aws", &["s3", "sync", &source, target_str])
            .await?;

        if !out.ok() {
            let msg = if !out.stderr.trim().is_empty() {
                out.stderr.trim().to_string()
            } else {
                out.stdout.trim().to_string()
            };
            sink.emit(CloneProgress::Error {
                message: msg.clone(),
            });
            return Err(CloudError::NetworkFailed {
                backend: "s3".to_string(),
                message: msg,
            });
        }

        // Replay any lines `aws s3 sync` printed, for log-panel parity
        // with the streaming GitHub clone. This is post-hoc rather than
        // live — US-008 can rewire to a real streaming runner once we
        // migrate off the CLI wrapper.
        for line in out.stdout.lines() {
            sink.emit(CloneProgress::Streaming {
                line: line.to_string(),
            });
        }

        let duration_ms = start.elapsed().as_millis() as u64;
        sink.emit(CloneProgress::Completed { duration_ms });

        Ok(ClonedHqSummary {
            target_dir: PathBuf::from(target_dir),
            backend: self.name().to_string(),
            duration_ms,
        })
    }

    fn name(&self) -> &'static str {
        "s3"
    }
}

// ──────────────────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    #[derive(Debug)]
    struct StubRunner {
        expected: Mutex<Vec<super::super::CommandOutput>>,
    }

    impl StubRunner {
        fn new(calls: Vec<super::super::CommandOutput>) -> Self {
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
            Ok(q.remove(0))
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
    fn normalize_prefix_strips_leading_slash() {
        assert_eq!(normalize_prefix("/hq/".into()), "hq/");
        assert_eq!(normalize_prefix("//hq".into()), "hq/");
    }

    #[test]
    fn normalize_prefix_appends_trailing_slash() {
        assert_eq!(normalize_prefix("hq".into()), "hq/");
        assert_eq!(normalize_prefix("hq/".into()), "hq/");
    }

    #[test]
    fn s3_uri_format() {
        let b = S3Backend::new("indigo-hq", "/stefan-hq");
        assert_eq!(b.uri(), "s3://indigo-hq/stefan-hq/");
    }

    #[test]
    fn parse_aws_s3_ls_recognizes_signature_files() {
        let stdout = "\
2024-04-01 12:34:56       4096 manifest.yaml
2024-04-01 12:35:10       2048 README.md
2024-04-01 12:40:00       1024 .claude/settings.json
";
        let info = parse_aws_s3_ls(stdout);
        assert!(info.exists);
        assert_eq!(info.estimated_size, Some(4096 + 2048 + 1024));
        // Latest timestamp is the .claude entry.
        assert_eq!(info.last_modified.as_deref(), Some("2024-04-01T12:40:00Z"));
    }

    #[test]
    fn parse_aws_s3_ls_missing_signature_means_not_exists() {
        let stdout = "\
2024-04-01 12:34:56        256 random.txt
2024-04-01 12:35:10        128 notes.md
";
        let info = parse_aws_s3_ls(stdout);
        assert!(!info.exists);
    }

    #[test]
    fn parse_aws_s3_ls_empty_stdout_is_not_found() {
        let info = parse_aws_s3_ls("");
        assert!(!info.exists);
        assert!(info.last_modified.is_none());
        assert!(info.estimated_size.is_none());
    }

    #[test]
    fn parse_aws_s3_ls_ignores_pre_rows() {
        // "aws s3 ls" without --recursive prints "PRE" rows for subdirs.
        let stdout = "\
                           PRE .claude/
                           PRE companies/
2024-04-01 12:34:56       4096 manifest.yaml
";
        let info = parse_aws_s3_ls(stdout);
        assert!(info.exists);
        assert_eq!(info.estimated_size, Some(4096));
    }

    #[test]
    fn classify_aws_ls_failure_not_found() {
        let err = classify_aws_ls_failure(1, "NoSuchBucket: The specified bucket does not exist");
        assert!(matches!(err, CloudError::NotFound { .. }));
    }

    #[test]
    fn classify_aws_ls_failure_access_denied() {
        let err = classify_aws_ls_failure(1, "An error occurred (403): Access Denied");
        assert!(matches!(err, CloudError::AuthFailed { .. }));
    }

    #[test]
    fn classify_aws_ls_failure_tool_missing_via_127() {
        let err = classify_aws_ls_failure(127, "");
        assert!(matches!(err, CloudError::ToolMissing { .. }));
    }

    #[tokio::test]
    async fn check_existing_parses_recursive_ls_happy_path() {
        let stdout = "\
2024-04-10 08:00:00       4096 manifest.yaml
2024-04-11 09:00:00       2048 README.md
";
        let runner = StubRunner::new(vec![ok(stdout)]);
        let backend = S3Backend::with_runner("indigo-hq", "stefan-hq", Arc::new(runner));
        let info = backend.check_existing().await.unwrap();
        assert!(info.exists);
        assert_eq!(info.last_modified.as_deref(), Some("2024-04-11T09:00:00Z"));
    }

    #[tokio::test]
    async fn check_existing_not_found_returns_empty_shape() {
        let runner = StubRunner::new(vec![fail(1, "NoSuchBucket: no such bucket")]);
        let backend = S3Backend::with_runner("nope", "hq", Arc::new(runner));
        let info = backend.check_existing().await.unwrap();
        assert!(!info.exists);
    }

    #[tokio::test]
    async fn check_existing_auth_propagates() {
        let runner = StubRunner::new(vec![fail(1, "Access Denied (403)")]);
        let backend = S3Backend::with_runner("locked", "hq", Arc::new(runner));
        let err = backend.check_existing().await.unwrap_err();
        assert!(matches!(err, CloudError::AuthFailed { .. }));
    }

    #[test]
    fn s3_backend_name_is_stable() {
        let b = S3Backend::new("bucket", "prefix");
        assert_eq!(b.name(), "s3");
        assert_eq!(b.bucket(), "bucket");
        assert_eq!(b.prefix(), "prefix/");
    }
}
