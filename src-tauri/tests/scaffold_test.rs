//! Integration tests for `core::scaffold`.
//!
//! Unit tests in `core/scaffold.rs` cover the pure helpers (grouping,
//! counting, top-level classification). These integration tests drive the
//! full scaffold into a temp dir + real git binary.

use std::sync::{Arc, Mutex};

use hq_installer_lib::core::scaffold::{
    scaffold_hq, ScaffoldError, ScaffoldEvent, ScaffoldSummary,
};

fn collect_events() -> (Arc<Mutex<Vec<ScaffoldEvent>>>, impl Fn(ScaffoldEvent) + Clone) {
    let buf: Arc<Mutex<Vec<ScaffoldEvent>>> = Arc::new(Mutex::new(Vec::new()));
    let buf_for_sink = buf.clone();
    let sink = move |ev: ScaffoldEvent| {
        buf_for_sink.lock().unwrap().push(ev);
    };
    (buf, sink)
}

#[test]
fn scaffold_to_empty_temp_dir_succeeds() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let target = tmp.path().join("hq-test");

    let (events, sink) = collect_events();
    let summary: ScaffoldSummary =
        scaffold_hq(&target, false, sink).expect("scaffold should succeed");

    assert!(summary.file_count > 0);
    assert_eq!(summary.target_dir, target);
    assert!(!summary.commit_sha.is_empty(), "commit sha must be set");

    // Verify expected files landed in the target dir.
    assert!(target.join("README.md").exists());
    assert!(target.join("CLAUDE.md").exists());
    assert!(target.join("USER-GUIDE.md").exists());
    assert!(target.join(".gitignore").exists());
    assert!(target.join(".claude/settings.json").exists());
    assert!(target.join("companies/manifest.yaml").exists());
    assert!(target.join("workers/registry.yaml").exists());

    // .git directory must exist after git init.
    assert!(target.join(".git").exists(), ".git dir missing");
    assert!(target.join(".git/HEAD").exists(), ".git/HEAD missing");

    // Event stream must include Started → ... → GitInit → GitCommit → Completed.
    let events = events.lock().unwrap();
    assert!(matches!(events.first(), Some(ScaffoldEvent::Started { .. })));
    assert!(
        events
            .iter()
            .any(|e| matches!(e, ScaffoldEvent::FileGroup { .. })),
        "at least one FileGroup event expected"
    );
    assert!(
        events.iter().any(|e| matches!(e, ScaffoldEvent::GitInit)),
        "GitInit event expected"
    );
    assert!(
        events
            .iter()
            .any(|e| matches!(e, ScaffoldEvent::GitCommit { .. })),
        "GitCommit event expected"
    );
    let last = events.last().expect("at least one event");
    assert!(
        matches!(
            last,
            ScaffoldEvent::Completed {
                duration_ms: _,
                file_count: _
            }
        ),
        "last event must be Completed, got {last:?}"
    );
}

#[test]
fn scaffold_refuses_non_empty_target_without_force() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let target = tmp.path().join("hq-test");
    std::fs::create_dir_all(&target).unwrap();
    std::fs::write(target.join("sentinel.txt"), b"already here").unwrap();

    let (events, sink) = collect_events();
    let result = scaffold_hq(&target, false, sink);

    match result {
        Err(ScaffoldError::TargetNotEmpty(path)) => assert_eq!(path, target),
        other => panic!("expected TargetNotEmpty, got {other:?}"),
    }

    // Sentinel must remain untouched — refusal is atomic.
    assert!(target.join("sentinel.txt").exists());
    // No HQ files should have been written.
    assert!(!target.join("README.md").exists());

    // No events should have been emitted when the refusal is immediate.
    assert!(events.lock().unwrap().is_empty());
}

#[test]
fn scaffold_with_force_overwrites_non_empty_target() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let target = tmp.path().join("hq-test");
    std::fs::create_dir_all(&target).unwrap();
    std::fs::write(target.join("sentinel.txt"), b"already here").unwrap();

    let (_events, sink) = collect_events();
    let summary = scaffold_hq(&target, true, sink).expect("force scaffold should succeed");

    assert!(summary.file_count > 0);
    // Sentinel is left alone — we don't delete foreign files, only overlay
    // the template.
    assert!(target.join("sentinel.txt").exists());
    // Template files are present.
    assert!(target.join("README.md").exists());
    assert!(target.join(".git").exists());
}

#[test]
fn scaffold_completes_under_five_seconds() {
    // Spec §5.5: "< 5 s for a standard HQ template on a modern Mac."
    // The minimal template is much smaller than the full HQ, so this should
    // complete in well under 1s in practice — the test just guards against
    // accidental O(n^2) regression.
    let tmp = tempfile::tempdir().expect("tempdir");
    let target = tmp.path().join("hq-test");

    let (_events, sink) = collect_events();
    let summary = scaffold_hq(&target, false, sink).expect("scaffold should succeed");

    assert!(
        summary.duration_ms < 5_000,
        "scaffold too slow: {}ms > 5000ms",
        summary.duration_ms
    );
}

#[test]
fn scaffold_initial_commit_message_is_exact() {
    // Spec §5.6: exact message is "Initial HQ". Contract with create-hq CLI.
    let tmp = tempfile::tempdir().expect("tempdir");
    let target = tmp.path().join("hq-test");

    let (_events, sink) = collect_events();
    let _summary = scaffold_hq(&target, false, sink).expect("scaffold should succeed");

    let out = std::process::Command::new("git")
        .args(["log", "-1", "--pretty=format:%s"])
        .current_dir(&target)
        .output()
        .expect("git log");
    let msg = String::from_utf8_lossy(&out.stdout).into_owned();
    assert_eq!(msg.trim(), "Initial HQ");
}

#[test]
fn scaffold_events_include_all_top_level_groups() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let target = tmp.path().join("hq-test");

    let (events, sink) = collect_events();
    let _ = scaffold_hq(&target, false, sink).expect("scaffold should succeed");

    let events = events.lock().unwrap();
    let group_names: Vec<&str> = events
        .iter()
        .filter_map(|e| match e {
            ScaffoldEvent::FileGroup { group, .. } => Some(group.as_str()),
            _ => None,
        })
        .collect();

    // Every top-level template directory must show up as a FileGroup event.
    for required in [".claude", "companies", "knowledge", "workers", "workspace"] {
        assert!(
            group_names.contains(&required),
            "missing FileGroup event for {required}, saw: {group_names:?}"
        );
    }
}

#[test]
fn scaffold_file_count_matches_events() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let target = tmp.path().join("hq-test");

    let (events, sink) = collect_events();
    let summary = scaffold_hq(&target, false, sink).expect("scaffold should succeed");

    // Started event's total_files must equal summary.file_count.
    let events = events.lock().unwrap();
    let started_total = events.iter().find_map(|e| match e {
        ScaffoldEvent::Started { total_files } => Some(*total_files),
        _ => None,
    });
    assert_eq!(started_total, Some(summary.file_count));

    // Sum of files_in_group across FileGroup events must equal total.
    let sum: usize = events
        .iter()
        .filter_map(|e| match e {
            ScaffoldEvent::FileGroup { files_in_group, .. } => Some(*files_in_group),
            _ => None,
        })
        .sum();
    assert_eq!(sum, summary.file_count);
}
