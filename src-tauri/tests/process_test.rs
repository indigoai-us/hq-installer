/// Acceptance tests for US-007: process.rs — streamed subprocess with cancellation.

#[cfg(test)]
mod process_tests {
    use hq_installer_lib::commands::process::{
        cancel_process_impl, lookup_pid, run_process_impl, ProcessEvent, SpawnArgs,
    };
    use std::fs;
    use std::os::unix::fs::PermissionsExt;
    use std::sync::{Arc, Mutex};
    use std::thread;
    use std::time::Duration;
    use tempfile::TempDir;
    use uuid::Uuid;

    /// Default search path for tests that don't care about PATH resolution —
    /// every system binary used (`echo`, `sleep`, `false`) lives in `/bin`
    /// or `/usr/bin`, so this covers them without leaking the host PATH.
    const TEST_SYSTEM_PATH: &str = "/usr/bin:/bin:/usr/sbin:/sbin";

    // ─────────────────────────────────────────────────────────────────────────
    // Helper: collect all events from a synchronous run
    // ─────────────────────────────────────────────────────────────────────────

    fn collect_events(args: SpawnArgs) -> (Vec<String>, Option<(Option<i32>, bool)>) {
        let stdout_lines: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(vec![]));
        let exit_info: Arc<Mutex<Option<(Option<i32>, bool)>>> = Arc::new(Mutex::new(None));

        let lines_ref = stdout_lines.clone();
        let exit_ref = exit_info.clone();

        let handle = Uuid::new_v4().to_string();
        run_process_impl(&handle, &args, TEST_SYSTEM_PATH, move |event| match event {
            ProcessEvent::Stdout(line) => {
                lines_ref.lock().unwrap().push(line);
            }
            ProcessEvent::Stderr(_) => {
                // Tests in this helper only assert on stdout; discard stderr.
            }
            ProcessEvent::Exit { code, success } => {
                *exit_ref.lock().unwrap() = Some((code, success));
            }
        })
        .expect("process should run to completion");

        let lines = stdout_lines.lock().unwrap().clone();
        let exit = *exit_info.lock().unwrap();
        (lines, exit)
    }

    /// Drop an executable shell script named `name` into `dir` that echoes
    /// `<name>-ok` to stdout and exits 0.
    fn make_fake_bin(dir: &TempDir, name: &str) {
        let path = dir.path().join(name);
        fs::write(&path, format!("#!/bin/sh\necho '{}-ok'\n", name)).unwrap();
        let mut perms = fs::metadata(&path).unwrap().permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&path, perms).unwrap();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Test 1: successful run — echo emits a stdout line and an exit(0) event
    // ─────────────────────────────────────────────────────────────────────────

    #[test]
    fn run_echo_emits_stdout_and_exit_zero() {
        let args = SpawnArgs {
            cmd: "echo".to_string(),
            args: vec!["hello from process".to_string()],
            cwd: None,
            env: None,
        };

        let (lines, exit) = collect_events(args);

        assert!(
            !lines.is_empty(),
            "should have received at least one stdout line"
        );
        assert!(
            lines.iter().any(|l| l.contains("hello from process")),
            "stdout should contain the echoed string, got: {:?}",
            lines
        );

        let (code, success) = exit.expect("exit event should have been emitted");
        assert_eq!(code, Some(0), "exit code should be 0");
        assert!(success, "exit should be marked successful");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Test 2: process is registered while running, deregistered after exit
    // ─────────────────────────────────────────────────────────────────────────

    #[test]
    fn process_registers_and_deregisters() {
        // Use a process that exits quickly.
        let args = SpawnArgs {
            cmd: "echo".to_string(),
            args: vec!["register-test".to_string()],
            cwd: None,
            env: None,
        };

        let handle = Uuid::new_v4().to_string();
        let handle_for_check = handle.clone();

        // After run_process_impl returns the handle must be gone.
        run_process_impl(&handle, &args, TEST_SYSTEM_PATH, |_| {}).expect("should run");
        assert!(
            lookup_pid(&handle_for_check).is_none(),
            "handle should be deregistered after the process exits"
        );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Test 3: cancel_process_impl sends SIGTERM and terminates a long-running
    //         process; returns true and the handle is cleaned up
    // ─────────────────────────────────────────────────────────────────────────

    #[test]
    fn cancel_process_terminates_running_process() {
        let args = SpawnArgs {
            cmd: "sleep".to_string(),
            args: vec!["30".to_string()], // won't finish on its own
            cwd: None,
            env: None,
        };

        let handle = format!("test-cancel-{}", Uuid::new_v4());
        let handle_thread = handle.clone();

        // Spawn the process in a background thread.
        thread::spawn(move || {
            let _ = run_process_impl(&handle_thread, &args, TEST_SYSTEM_PATH, |_| {});
        });

        // Give the process time to start and register.
        thread::sleep(Duration::from_millis(200));
        assert!(
            lookup_pid(&handle).is_some(),
            "process should be registered while running"
        );

        // Cancel with a very short SIGKILL escalation timeout for test speed.
        let cancelled = cancel_process_impl(&handle, Duration::from_millis(500));
        assert!(cancelled, "cancel_process_impl should return true for a registered handle");

        // SIGTERM causes sleep to exit quickly; the run thread deregisters it.
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        loop {
            if lookup_pid(&handle).is_none() {
                break;
            }
            if std::time::Instant::now() >= deadline {
                panic!("process was not deregistered within 2 s after SIGTERM");
            }
            thread::sleep(Duration::from_millis(50));
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Test 4: cancel_process_impl returns false for an unknown handle
    // ─────────────────────────────────────────────────────────────────────────

    #[test]
    fn cancel_process_unknown_handle_returns_false() {
        let result = cancel_process_impl("no-such-handle-xyz-999", Duration::from_secs(5));
        assert!(
            !result,
            "cancel_process_impl should return false for an unregistered handle"
        );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Test 5: non-zero exit code is captured correctly
    // ─────────────────────────────────────────────────────────────────────────

    #[test]
    fn run_false_emits_nonzero_exit() {
        let args = SpawnArgs {
            cmd: "false".to_string(),
            args: vec![],
            cwd: None,
            env: None,
        };

        let (_, exit) = collect_events(args);

        let (code, success) = exit.expect("exit event should have been emitted");
        assert_ne!(code, Some(0), "exit code should be non-zero for `false`");
        assert!(!success, "exit should not be successful for `false`");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Test 6: bare command name is resolved via the caller-supplied search
    //         path — e.g. `qmd` living in ~/.nvm/.../bin gets found when a
    //         GUI-launched app would otherwise see only `/usr/bin:/bin`.
    //         This is the primary bug this change fixes.
    // ─────────────────────────────────────────────────────────────────────────

    #[test]
    fn run_process_impl_resolves_cmd_via_search_path() {
        let dir = TempDir::new().unwrap();
        make_fake_bin(&dir, "fakebin");

        let args = SpawnArgs {
            cmd: "fakebin".to_string(),
            args: vec![],
            cwd: None,
            env: None,
        };

        let stdout_lines: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(vec![]));
        let exit_info: Arc<Mutex<Option<(Option<i32>, bool)>>> = Arc::new(Mutex::new(None));
        let lines_ref = stdout_lines.clone();
        let exit_ref = exit_info.clone();

        let handle = Uuid::new_v4().to_string();
        // Search path points ONLY at the tempdir — a bare name resolves only
        // if run_process_impl is using it.
        let search_path = dir.path().to_str().unwrap();
        run_process_impl(&handle, &args, search_path, move |event| match event {
            ProcessEvent::Stdout(line) => lines_ref.lock().unwrap().push(line),
            ProcessEvent::Exit { code, success } => {
                *exit_ref.lock().unwrap() = Some((code, success));
            }
            ProcessEvent::Stderr(_) => {}
        })
        .expect("fakebin should have been resolved and run");

        let lines = stdout_lines.lock().unwrap().clone();
        assert!(
            lines.iter().any(|l| l.contains("fakebin-ok")),
            "stdout should contain fakebin output, got: {:?}",
            lines
        );
        let (code, success) = exit_info.lock().unwrap().expect("exit event");
        assert_eq!(code, Some(0));
        assert!(success);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Test 7: missing command returns Err synchronously, no hang.
    //         Before the fix, a bare cmd not on PATH would spawn-fail on a
    //         background thread and emit an error exit event that the JS
    //         side could miss (race), leaving the UI stuck at "Running…".
    //         After the fix, run_process_impl resolves the cmd before
    //         spawning and returns Err immediately if not found.
    // ─────────────────────────────────────────────────────────────────────────

    #[test]
    fn run_process_impl_errs_when_cmd_not_found_in_search_path() {
        let empty_dir = TempDir::new().unwrap();
        let args = SpawnArgs {
            cmd: "definitely_not_a_real_binary_xyz123".to_string(),
            args: vec![],
            cwd: None,
            env: None,
        };

        let handle = Uuid::new_v4().to_string();
        let result = run_process_impl(
            &handle,
            &args,
            empty_dir.path().to_str().unwrap(),
            |_| {},
        );

        let err = result.expect_err("should fail when cmd is not in search path");
        assert!(
            err.to_lowercase().contains("not found") || err.contains("definitely_not_a_real_binary_xyz123"),
            "error message should mention the missing cmd, got: {}",
            err
        );
        assert!(
            lookup_pid(&handle).is_none(),
            "no pid should be registered after a resolution failure"
        );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Test 8: child PATH env reflects the search path so grandchildren
    //         (e.g. qmd → git, npm → node) can find their own tools.
    // ─────────────────────────────────────────────────────────────────────────

    #[test]
    fn run_process_impl_sets_child_path_env() {
        let dir = TempDir::new().unwrap();
        // Use /bin/sh to echo $PATH — works on any macOS/Linux. The search
        // path seeds PATH for the child; we verify by reading it from the
        // child's view.
        let args = SpawnArgs {
            cmd: "sh".to_string(),
            args: vec!["-c".to_string(), "echo \"PATH=$PATH\"".to_string()],
            cwd: None,
            env: None,
        };

        // Build a search path that contains /bin (so sh is found) + our marker dir.
        let marker = dir.path().to_str().unwrap();
        let search_path = format!("/usr/bin:/bin:{}", marker);

        let stdout_lines: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(vec![]));
        let lines_ref = stdout_lines.clone();
        let handle = Uuid::new_v4().to_string();

        run_process_impl(&handle, &args, &search_path, move |event| {
            if let ProcessEvent::Stdout(line) = event {
                lines_ref.lock().unwrap().push(line);
            }
        })
        .expect("sh -c echo should run");

        let lines = stdout_lines.lock().unwrap().clone();
        let path_line = lines
            .iter()
            .find(|l| l.starts_with("PATH="))
            .expect("child should have echoed PATH=");
        assert!(
            path_line.contains(marker),
            "child PATH should include the search path marker {}, got: {}",
            marker,
            path_line
        );
    }
}
