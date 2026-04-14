/// Acceptance tests for US-007: process.rs — streamed subprocess with cancellation.

#[cfg(test)]
mod process_tests {
    use hq_installer_lib::commands::process::{
        cancel_process_impl, lookup_pid, run_process_impl, ProcessEvent, SpawnArgs,
    };
    use std::sync::{Arc, Mutex};
    use std::thread;
    use std::time::Duration;
    use uuid::Uuid;

    // ─────────────────────────────────────────────────────────────────────────
    // Helper: collect all events from a synchronous run
    // ─────────────────────────────────────────────────────────────────────────

    fn collect_events(args: SpawnArgs) -> (Vec<String>, Option<(Option<i32>, bool)>) {
        let stdout_lines: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(vec![]));
        let exit_info: Arc<Mutex<Option<(Option<i32>, bool)>>> = Arc::new(Mutex::new(None));

        let lines_ref = stdout_lines.clone();
        let exit_ref = exit_info.clone();

        let handle = Uuid::new_v4().to_string();
        run_process_impl(&handle, &args, move |event| match event {
            ProcessEvent::Stdout(line) => {
                lines_ref.lock().unwrap().push(line);
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
        run_process_impl(&handle, &args, |_| {}).expect("should run");
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
            let _ = run_process_impl(&handle_thread, &args, |_| {});
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
}
