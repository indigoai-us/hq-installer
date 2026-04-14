/// Acceptance tests for US-004: xcode.rs — Xcode Command Line Tools install + polling.
///
/// Tests use injectable `clt_dir` parameters (TempDir) so no real
/// `/Library/Developer/CommandLineTools` access is ever made.

#[cfg(test)]
mod xcode_tests {
    use hq_installer_lib::commands::xcode::{
        xcode_clt_status_impl, XcodeCltState, reset_xcode_state, set_xcode_state_installing,
        xcode_clt_poll_impl,
    };
    use serial_test::serial;
    use tempfile::TempDir;
    use tokio::runtime::Runtime;

    // ─────────────────────────────────────────────────────────────────────────
    // Test 1: status → NotInstalled when CLT dir is absent
    // ─────────────────────────────────────────────────────────────────────────
    #[test]
    #[serial]
    fn xcode_clt_status_not_installed_when_dir_absent() {
        let dir = TempDir::new().unwrap();
        // Use a path that doesn't exist inside the temp dir.
        let absent = dir.path().join("CommandLineTools");
        assert!(!absent.exists(), "precondition: dir must not exist");

        reset_xcode_state();
        let state = xcode_clt_status_impl(&absent);

        assert!(
            matches!(state, XcodeCltState::NotInstalled),
            "expected NotInstalled when CLT dir is absent, got {:?}",
            state
        );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Test 2: status → Installed when CLT dir exists
    // ─────────────────────────────────────────────────────────────────────────
    #[test]
    #[serial]
    fn xcode_clt_status_installed_when_dir_present() {
        let dir = TempDir::new().unwrap();
        let clt_dir = dir.path().join("CommandLineTools");
        std::fs::create_dir_all(&clt_dir).unwrap();

        reset_xcode_state();
        let state = xcode_clt_status_impl(&clt_dir);

        assert!(
            matches!(state, XcodeCltState::Installed),
            "expected Installed when CLT dir exists, got {:?}",
            state
        );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Test 3: status → Installing when installing flag is set (dir absent)
    // ─────────────────────────────────────────────────────────────────────────
    #[test]
    #[serial]
    fn xcode_clt_status_installing_when_flag_set() {
        let dir = TempDir::new().unwrap();
        let absent = dir.path().join("CommandLineTools");
        assert!(!absent.exists(), "precondition: dir must not exist");

        // Force global state to Installing.
        set_xcode_state_installing("test-handle-003".to_string());
        let state = xcode_clt_status_impl(&absent);
        reset_xcode_state(); // clean up for other tests

        assert!(
            matches!(state, XcodeCltState::Installing),
            "expected Installing when flag is set, got {:?}",
            state
        );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Test 4: state machine transition NotInstalled → Installing
    // ─────────────────────────────────────────────────────────────────────────
    #[test]
    #[serial]
    fn xcode_clt_state_transitions_not_installed_to_installing() {
        let dir = TempDir::new().unwrap();
        let absent = dir.path().join("CommandLineTools");

        // Start from NotInstalled.
        reset_xcode_state();
        let before = xcode_clt_status_impl(&absent);
        assert!(
            matches!(before, XcodeCltState::NotInstalled),
            "should start as NotInstalled"
        );

        // Transition to Installing.
        set_xcode_state_installing("test-handle-004".to_string());
        let after = xcode_clt_status_impl(&absent);
        reset_xcode_state();

        assert!(
            matches!(after, XcodeCltState::Installing),
            "should be Installing after transition, got {:?}",
            after
        );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Test 5: poller detects Installed when dir appears
    // ─────────────────────────────────────────────────────────────────────────
    #[test]
    #[serial]
    fn xcode_clt_poll_detects_installed_dir() {
        let rt = Runtime::new().unwrap();

        let dir = TempDir::new().unwrap();
        let clt_dir = dir.path().join("CommandLineTools");
        let clt_dir_clone = clt_dir.clone();

        // Spawn a thread that creates the dir after a short delay.
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(100));
            std::fs::create_dir_all(&clt_dir_clone).unwrap();
        });

        reset_xcode_state();

        // Run the poller with a short timeout (3 seconds) and 50ms poll interval.
        let result = rt.block_on(xcode_clt_poll_impl(
            clt_dir.clone(),
            "test-handle-005".to_string(),
            3,    // timeout_secs
            50,   // poll_interval_ms (short for tests)
        ));

        reset_xcode_state();

        assert!(
            result.is_ok(),
            "poller should succeed when dir appears, got {:?}",
            result
        );
        assert!(
            matches!(result.unwrap(), XcodeCltState::Installed),
            "poller result should be Installed"
        );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Test 6: poller times out when dir never appears
    // ─────────────────────────────────────────────────────────────────────────
    #[test]
    #[serial]
    fn xcode_clt_poll_times_out_when_dir_never_appears() {
        let rt = Runtime::new().unwrap();

        let dir = TempDir::new().unwrap();
        let absent = dir.path().join("CommandLineTools");

        reset_xcode_state();

        // 1s timeout, dir never created → should time out.
        let result = rt.block_on(xcode_clt_poll_impl(
            absent.clone(),
            "test-handle-006".to_string(),
            1,   // timeout_secs
            50,  // poll_interval_ms
        ));

        reset_xcode_state();

        assert!(
            result.is_err(),
            "poller should return Err on timeout, got {:?}",
            result
        );
        let err = result.unwrap_err();
        assert!(
            err.contains("timed out"),
            "error should mention 'timed out', got: {}",
            err
        );
    }
}
