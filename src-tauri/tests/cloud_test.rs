//! Integration tests for `core::cloud`.
//!
//! Unit tests in `core/cloud.rs`, `core/cloud/github.rs`, and
//! `core/cloud/s3.rs` cover parsers, classifiers, and the `StubRunner`-
//! driven `check_existing` paths. These integration tests drive the full
//! streaming clone machinery against a **real local bare git repo**
//! exposed as `file://…`, which exercises the same code path a remote
//! `gh repo clone` would use without needing `gh` or the network.
//!
//! The bare-repo trick is worth highlighting: `git clone file://<path>`
//! uses the exact same object transfer machinery and progress output as
//! a network clone. The only thing that isn't exercised is the TLS
//! layer, which isn't our code anyway.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;

use hq_installer_lib::core::cloud::{
    github::{parse_gh_repo_view, run_streaming_clone},
    s3::parse_aws_s3_ls,
    target_is_clean, CloneProgress, CloneProgressSink, CloudError, CommandOutput, CommandRunner,
    ExistingInfo,
};

// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────

/// Collect every progress event into a `Vec` the test can introspect
/// after the clone returns. Uses `Arc<Mutex<_>>` so the closure's borrow
/// can outlive the capture.
fn collect_events() -> (Arc<Mutex<Vec<CloneProgress>>>, impl Fn(CloneProgress) + Clone) {
    let buf: Arc<Mutex<Vec<CloneProgress>>> = Arc::new(Mutex::new(Vec::new()));
    let buf_for_sink = buf.clone();
    let sink = move |ev: CloneProgress| {
        buf_for_sink.lock().unwrap().push(ev);
    };
    (buf, sink)
}

/// Build a local bare git repository with a single committed file so it
/// can be cloned via `file://`. Returns the bare repo path (what we'd
/// pass to `git clone`) and the tempdir so it stays alive for the test.
fn make_local_bare_repo() -> (tempfile::TempDir, PathBuf) {
    let tmp = tempfile::tempdir().expect("tempdir");

    // Step 1: create a working repo, commit something, then push to a
    // freshly-initialized bare repo. This mirrors how `gh repo clone`
    // would see a real remote: a bare repo with at least one commit.
    let work_dir = tmp.path().join("work");
    let bare_dir = tmp.path().join("bare.git");
    std::fs::create_dir_all(&work_dir).unwrap();

    run_git(&work_dir, &["init", "-q", "-b", "main"]);
    // Configure identity so `git commit` doesn't fail on machines
    // without a global config.
    run_git(&work_dir, &["config", "user.email", "test@example.invalid"]);
    run_git(&work_dir, &["config", "user.name", "Test"]);

    std::fs::write(work_dir.join("README.md"), b"# hq test fixture\n").unwrap();
    run_git(&work_dir, &["add", "README.md"]);
    run_git(&work_dir, &["commit", "-q", "-m", "init"]);

    // Init bare, then push from work → bare.
    //
    // `Command::current_dir()` fails with NotFound if the directory
    // doesn't already exist, so we create it before spawning git. Git
    // itself is happy to init into an existing empty directory.
    std::fs::create_dir_all(&bare_dir).unwrap();
    run_git(&bare_dir, &["init", "-q", "--bare", "-b", "main"]);
    run_git(
        &work_dir,
        &[
            "remote",
            "add",
            "origin",
            bare_dir.to_str().expect("bare path utf-8"),
        ],
    );
    run_git(&work_dir, &["push", "-q", "origin", "main"]);

    (tmp, bare_dir)
}

/// Run a git command with the given working directory, failing the test
/// on non-zero exit — prefer this over silently ignoring failures so
/// fixture setup errors surface immediately.
fn run_git(cwd: &Path, args: &[&str]) {
    // `-c init.defaultBranch=main` short-circuits the "hint" noise some
    // git versions print about default branch names.
    let out = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .expect("spawn git");
    assert!(
        out.status.success(),
        "git {args:?} failed at {cwd:?}: {}\nstdout: {}\nstderr: {}",
        out.status,
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr),
    );
}

// ──────────────────────────────────────────────────────────────────────────
// Parser sanity checks via the public API
// ──────────────────────────────────────────────────────────────────────────

#[test]
fn gh_parser_is_exported_and_round_trips() {
    // Sanity check that the parser is re-exported from the library and
    // accessible to integration tests. Duplicates one unit test case on
    // purpose — if we accidentally make the parser private in a
    // refactor, this file will fail to compile.
    let info = parse_gh_repo_view(
        r#"{"name":"hq","updatedAt":"2026-04-10T12:00:00Z","diskUsage":1024}"#,
    )
    .expect("parse success");
    assert!(info.exists);
    assert_eq!(info.estimated_size, Some(1024 * 1024));
}

#[test]
fn s3_parser_is_exported_and_round_trips() {
    let info = parse_aws_s3_ls(
        "\
2026-04-10 12:00:00       4096 manifest.yaml
2026-04-10 12:00:05       2048 README.md
",
    );
    assert!(info.exists);
    assert_eq!(info.estimated_size, Some(4096 + 2048));
}

// ──────────────────────────────────────────────────────────────────────────
// target_is_clean
// ──────────────────────────────────────────────────────────────────────────

#[test]
fn target_is_clean_real_tempdir() {
    let tmp = tempfile::tempdir().unwrap();
    // Freshly-created tempdir is empty → clean.
    assert!(target_is_clean(tmp.path()).unwrap());

    // Drop a file → not clean.
    std::fs::write(tmp.path().join("x"), b"y").unwrap();
    assert!(!target_is_clean(tmp.path()).unwrap());
}

// ──────────────────────────────────────────────────────────────────────────
// Streaming clone against a real local bare repo
// ──────────────────────────────────────────────────────────────────────────

/// The big one: clone a real local bare repo through
/// `run_streaming_clone` and verify every public contract the GUI layer
/// relies on.
#[tokio::test]
async fn run_streaming_clone_against_local_bare_repo_succeeds() {
    let (_tmp, bare_path) = make_local_bare_repo();
    let clone_target = _tmp.path().join("cloned");
    let bare_url = format!("file://{}", bare_path.display());

    let (events, sink) = collect_events();

    let duration_ms = run_streaming_clone(
        "git",
        &[
            "clone",
            "--progress", // force progress output even when stderr is piped
            &bare_url,
            clone_target.to_str().expect("target utf-8"),
        ],
        &sink,
    )
    .await
    .expect("clone should succeed");

    // 1. The clone target now has the committed README.
    assert!(
        clone_target.join("README.md").exists(),
        "README.md missing in cloned target"
    );
    assert!(
        clone_target.join(".git").exists(),
        ".git dir missing in cloned target"
    );

    // 2. Duration is real (non-zero).
    // We don't assert > N because CI machines can be fast enough to
    // register 0ms. A zero-duration successful clone is fine — what we
    // really want to check is that the function *returns* the duration.
    let events = events.lock().unwrap();
    let completed_duration = events.iter().find_map(|e| match e {
        CloneProgress::Completed { duration_ms } => Some(*duration_ms),
        _ => None,
    });
    assert_eq!(
        completed_duration,
        Some(duration_ms),
        "Completed event duration must match return value"
    );

    // 3. Event stream ordering: no Error event, Completed is last.
    assert!(
        !events.iter().any(|e| matches!(e, CloneProgress::Error { .. })),
        "no Error events expected on happy path"
    );
    let last = events.last().expect("at least one event");
    assert!(
        matches!(last, CloneProgress::Completed { .. }),
        "last event must be Completed, got {last:?}"
    );

    // 4. Streaming events are present — git always prints at least a
    // handful of stderr lines for `--progress`.
    let streaming_count = events
        .iter()
        .filter(|e| matches!(e, CloneProgress::Streaming { .. }))
        .count();
    assert!(
        streaming_count > 0,
        "expected at least one Streaming event, got {streaming_count}"
    );
}

/// Clone against a bogus tool name → ToolMissing.
///
/// This exercises the `ErrorKind::NotFound` → `CloudError::ToolMissing`
/// mapping inside `run_streaming_clone`, which is the same mapping the
/// renderer uses to decide "show the 'please install gh' hint".
#[tokio::test]
async fn run_streaming_clone_missing_tool_maps_to_tool_missing() {
    let (_events, sink) = collect_events();

    let err = run_streaming_clone(
        "definitely-not-a-real-binary-xyz-12345",
        &["--help"],
        &sink,
    )
    .await
    .expect_err("nonexistent tool must fail");

    match err {
        CloudError::ToolMissing { tool } => {
            assert_eq!(tool, "definitely-not-a-real-binary-xyz-12345");
        }
        other => panic!("expected ToolMissing, got {other:?}"),
    }
}

/// Clone a bogus source path through `git` → NetworkFailed (git exits
/// non-zero, we capture stderr, wrap in `NetworkFailed`).
#[tokio::test]
async fn run_streaming_clone_bad_source_maps_to_network_failed() {
    let tmp = tempfile::tempdir().unwrap();
    let target = tmp.path().join("out");
    let bogus = format!(
        "file://{}",
        tmp.path().join("definitely-does-not-exist.git").display()
    );

    let (events, sink) = collect_events();

    let err = run_streaming_clone(
        "git",
        &["clone", &bogus, target.to_str().unwrap()],
        &sink,
    )
    .await
    .expect_err("clone of nonexistent bare repo must fail");

    match err {
        CloudError::NetworkFailed { backend, message } => {
            assert_eq!(backend, "git");
            assert!(
                !message.is_empty(),
                "NetworkFailed.message should carry git's stderr"
            );
        }
        other => panic!("expected NetworkFailed, got {other:?}"),
    }

    // An Error event should have been emitted.
    let events = events.lock().unwrap();
    assert!(
        events
            .iter()
            .any(|e| matches!(e, CloneProgress::Error { .. })),
        "expected Error event on failed clone, got {events:?}"
    );
}

// ──────────────────────────────────────────────────────────────────────────
// CommandRunner + CloudBackend integration via a user-defined stub
// ──────────────────────────────────────────────────────────────────────────

/// A runner the integration tests own themselves. Mirrors the pattern
/// used inside the unit test modules, but defined here so integration
/// tests don't depend on private test types.
#[derive(Debug)]
struct IntegrationStubRunner {
    queue: Mutex<Vec<CommandOutput>>,
}

impl IntegrationStubRunner {
    fn new(responses: Vec<CommandOutput>) -> Self {
        Self {
            queue: Mutex::new(responses),
        }
    }
}

#[async_trait]
impl CommandRunner for IntegrationStubRunner {
    async fn run(&self, _cmd: &str, _args: &[&str]) -> Result<CommandOutput, CloudError> {
        let mut q = self.queue.lock().unwrap();
        if q.is_empty() {
            panic!("IntegrationStubRunner called more times than scripted");
        }
        Ok(q.remove(0))
    }
}

#[tokio::test]
async fn github_backend_check_existing_with_integration_stub() {
    use hq_installer_lib::core::cloud::{github::GithubBackend, CloudBackend};

    let runner = IntegrationStubRunner::new(vec![CommandOutput {
        status: 0,
        stdout: r#"{"name":"hq","updatedAt":"2026-04-10T12:00:00Z","diskUsage":2048}"#
            .to_string(),
        stderr: String::new(),
    }]);
    let backend = GithubBackend::with_runner("owner/hq", Arc::new(runner));
    let info: ExistingInfo = backend.check_existing().await.unwrap();

    assert!(info.exists);
    assert_eq!(info.estimated_size, Some(2_097_152));
    assert_eq!(info.last_modified.as_deref(), Some("2026-04-10T12:00:00Z"));
}

#[tokio::test]
async fn s3_backend_check_existing_with_integration_stub() {
    use hq_installer_lib::core::cloud::{s3::S3Backend, CloudBackend};

    let runner = IntegrationStubRunner::new(vec![CommandOutput {
        status: 0,
        stdout: "\
2026-04-10 12:00:00       4096 manifest.yaml
2026-04-11 13:00:00       1024 .claude/settings.json
"
        .to_string(),
        stderr: String::new(),
    }]);
    let backend = S3Backend::with_runner("indigo-hq", "stefan-hq", Arc::new(runner));
    let info = backend.check_existing().await.unwrap();

    assert!(info.exists);
    assert_eq!(info.estimated_size, Some(4096 + 1024));
    assert_eq!(info.last_modified.as_deref(), Some("2026-04-11T13:00:00Z"));
}

/// Sink + sink trait: verify the closure blanket impl works when the
/// sink is passed through a `&dyn CloneProgressSink` reference. The core
/// tests cover this too, but repeating it here guards against accidental
/// changes to the blanket impl signature.
#[test]
fn closure_sink_trait_is_accessible_from_integration_tests() {
    let counter = Arc::new(Mutex::new(0usize));
    let counter_ref = counter.clone();
    let sink = move |_ev: CloneProgress| {
        *counter_ref.lock().unwrap() += 1;
    };

    fn consume(s: &dyn CloneProgressSink) {
        s.emit(CloneProgress::Started {
            backend: "test".into(),
            source: "spec".into(),
        });
    }

    consume(&sink);
    assert_eq!(*counter.lock().unwrap(), 1);
}
