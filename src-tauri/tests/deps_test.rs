/// Acceptance tests for US-003: Rust deps.rs probe and install commands.
///
/// Tests use `check_dep_in` (a thin wrapper around the public `check_dep`
/// logic that accepts an explicit search path) to stay fully thread-safe —
/// no global PATH mutation is needed, so tests can run in parallel.

#[cfg(test)]
mod deps_tests {
    use hq_installer_lib::commands::deps::{
        cancel_install, check_dep_in, extended_search_path, format_install_error,
        register_cancel_handle,
    };
    use std::fs;
    use std::os::unix::fs::PermissionsExt;
    use tempfile::TempDir;

    /// Create a temporary directory containing a minimal shell script that:
    ///   - prints `<name> version 1.2.3` to stdout
    ///   - exits 0
    fn make_fake_bin(dir: &TempDir, name: &str) {
        let path = dir.path().join(name);
        fs::write(
            &path,
            format!("#!/bin/sh\necho '{} version 1.2.3'\n", name),
        )
        .unwrap();
        let mut perms = fs::metadata(&path).unwrap().permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&path, perms).unwrap();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Test 1: check_dep_in returns installed:true when tool is in the given dir
    // ─────────────────────────────────────────────────────────────────────────
    #[test]
    fn test_check_dep_installed_when_present() {
        let dir = TempDir::new().unwrap();
        make_fake_bin(&dir, "mytool");

        let status = check_dep_in("mytool", dir.path().to_str().unwrap());

        assert!(
            status.installed,
            "check_dep should report installed:true when binary is in the search path"
        );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Test 2: check_dep_in returns installed:false when tool is absent
    // ─────────────────────────────────────────────────────────────────────────
    #[test]
    fn test_check_dep_not_installed_when_absent() {
        // Use an empty dir that contains no binaries.
        let dir = TempDir::new().unwrap();

        let status = check_dep_in("definitely_not_a_real_binary_xyz123", dir.path().to_str().unwrap());

        assert!(
            !status.installed,
            "check_dep should report installed:false when binary is not in path"
        );
        assert!(status.version.is_none(), "version should be None when not installed");
        assert!(status.path.is_none(), "path should be None when not installed");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Test 3: check_dep_in returns a non-empty version string when present
    // ─────────────────────────────────────────────────────────────────────────
    #[test]
    fn test_check_dep_returns_version_string() {
        let dir = TempDir::new().unwrap();
        make_fake_bin(&dir, "versiontool");

        let status = check_dep_in("versiontool", dir.path().to_str().unwrap());

        assert!(status.installed, "should be installed");
        let version = status.version.expect("version should be Some when installed");
        assert!(
            !version.is_empty(),
            "version string should be non-empty, got: {:?}",
            version
        );
        // The fake binary prints "versiontool version 1.2.3"
        assert!(
            version.contains("1.2.3"),
            "version should contain '1.2.3', got: {:?}",
            version
        );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Test 4: check_dep_in populates path when tool is present
    // ─────────────────────────────────────────────────────────────────────────
    #[test]
    fn test_check_dep_returns_path_when_present() {
        let dir = TempDir::new().unwrap();
        make_fake_bin(&dir, "pathtool");

        let status = check_dep_in("pathtool", dir.path().to_str().unwrap());

        assert!(status.installed, "should be installed");
        let path = status.path.expect("path should be Some when installed");
        assert!(
            path.exists(),
            "returned path should point to an existing file: {:?}",
            path
        );
        assert!(
            path.ends_with("pathtool"),
            "path should end with binary name, got: {:?}",
            path
        );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Test 5: cancel_install returns false for an unknown handle
    // ─────────────────────────────────────────────────────────────────────────
    #[test]
    fn test_cancel_install_unknown_handle_returns_false() {
        let result = cancel_install("handle-that-does-not-exist-abc999".to_string());
        assert!(
            !result,
            "cancel_install should return false for an unregistered handle"
        );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Test 6: cancel_install sets the flag for a registered handle
    // ─────────────────────────────────────────────────────────────────────────
    #[test]
    fn test_cancel_install_sets_flag_for_registered_handle() {
        let handle = "test-handle-registered-001".to_string();

        // Register the handle as if an install had started.
        register_cancel_handle(handle.clone());

        // Cancel should now succeed.
        let result = cancel_install(handle);
        assert!(
            result,
            "cancel_install should return true when the handle is registered"
        );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Test 7: fake "node" binary is detected (regression guard)
    // ─────────────────────────────────────────────────────────────────────────
    #[test]
    fn test_check_dep_node_when_faked() {
        let dir = TempDir::new().unwrap();
        make_fake_bin(&dir, "node");

        let status = check_dep_in("node", dir.path().to_str().unwrap());

        assert!(status.installed, "node should be detected as installed");
        assert!(status.version.is_some(), "node version should be populated");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Test 8: fake "git" binary is detected (regression guard)
    // ─────────────────────────────────────────────────────────────────────────
    #[test]
    fn test_check_dep_git_when_faked() {
        let dir = TempDir::new().unwrap();
        make_fake_bin(&dir, "git");

        let status = check_dep_in("git", dir.path().to_str().unwrap());

        assert!(status.installed, "git should be detected as installed");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Test 9: fake "gh" binary is detected (regression guard)
    // ─────────────────────────────────────────────────────────────────────────
    #[test]
    fn test_check_dep_gh_when_faked() {
        let dir = TempDir::new().unwrap();
        make_fake_bin(&dir, "gh");

        let status = check_dep_in("gh", dir.path().to_str().unwrap());

        assert!(status.installed, "gh should be detected as installed");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Test 10: fake "brew" binary is detected (regression guard)
    // ─────────────────────────────────────────────────────────────────────────
    #[test]
    fn test_check_dep_brew_when_faked() {
        let dir = TempDir::new().unwrap();
        make_fake_bin(&dir, "brew");

        let status = check_dep_in("brew", dir.path().to_str().unwrap());

        assert!(status.installed, "brew should be detected as installed");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Test 11: extended_search_path returns a non-empty PATH and contains
    //          the static macOS extras a GUI-launched app would otherwise
    //          miss. Also exercises the shell-derived seeding path so
    //          nvm/fnm/asdf installations of qmd, claude, etc. are reachable.
    // ─────────────────────────────────────────────────────────────────────────
    #[test]
    fn test_extended_search_path_includes_static_extras() {
        let path = extended_search_path();
        assert!(!path.is_empty(), "extended_search_path should not be empty");
        assert!(
            path.contains("/opt/homebrew/bin"),
            "should include Apple Silicon Homebrew prefix, got: {}",
            path
        );
        assert!(
            path.contains("/usr/local/bin"),
            "should include Intel Homebrew / generic prefix, got: {}",
            path
        );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Test 12: format_install_error surfaces stderr when available.
    //          Regression guard for the "npm -g fails silently" bug — before
    //          this, `install_claude_code` / `install_qmd` failures reported
    //          only "Process exited with code 1" because stderr was never
    //          drained. The new run_streaming drains stderr and the error
    //          message must include the real npm output so the UI can show
    //          users what actually went wrong (EACCES, registry, engine, etc.)
    // ─────────────────────────────────────────────────────────────────────────
    #[test]
    fn test_format_install_error_includes_stderr_tail() {
        let lines = vec![
            "npm WARN config global `--global` is deprecated".to_string(),
            "npm ERR! code EACCES".to_string(),
            "npm ERR! syscall mkdir".to_string(),
            "npm ERR! path /opt/homebrew/lib/node_modules/@anthropic-ai".to_string(),
            "npm ERR! errno -13".to_string(),
        ];
        let msg = format_install_error(1, &lines);
        assert!(msg.contains("code 1"), "should include exit code, got: {}", msg);
        assert!(
            msg.contains("EACCES"),
            "should surface the real error from stderr, got: {}",
            msg
        );
        assert!(
            msg.contains("mkdir"),
            "should include recent stderr context, got: {}",
            msg
        );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Test 13: format_install_error keeps only the last few non-empty lines
    //          so the UI doesn't get flooded when an installer dumps kilobytes
    //          of output before failing.
    // ─────────────────────────────────────────────────────────────────────────
    #[test]
    fn test_format_install_error_caps_at_five_lines() {
        let lines: Vec<String> = (0..20).map(|i| format!("line {}", i)).collect();
        let msg = format_install_error(2, &lines);
        // Last five lines should appear; earlier ones should not.
        assert!(msg.contains("line 19"), "should include last line, got: {}", msg);
        assert!(msg.contains("line 15"), "should include 5th-from-last, got: {}", msg);
        assert!(
            !msg.contains("line 14"),
            "should not include lines older than last 5, got: {}",
            msg
        );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Test 14: format_install_error filters blank lines so messages stay
    //          compact even when a tool pads its output with whitespace.
    // ─────────────────────────────────────────────────────────────────────────
    #[test]
    fn test_format_install_error_skips_blank_lines() {
        let lines = vec![
            "real error here".to_string(),
            "".to_string(),
            "   ".to_string(),
            "second real line".to_string(),
        ];
        let msg = format_install_error(1, &lines);
        assert!(msg.contains("real error here"));
        assert!(msg.contains("second real line"));
        // Delimiter between real lines only — no double-pipe from blanks.
        assert!(!msg.contains("| |"), "should not double-delimit blanks: {}", msg);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Test 15: format_install_error falls back to a generic message when
    //          there's no stderr (e.g. the tool wrote only to stdout before
    //          dying). The generic form must still mention the exit code.
    // ─────────────────────────────────────────────────────────────────────────
    #[test]
    fn test_format_install_error_empty_stderr_uses_exit_code() {
        let msg = format_install_error(127, &[]);
        assert!(msg.contains("127"), "should mention exit code, got: {}", msg);
        assert!(
            !msg.contains(":"),
            "should not have 'code N:' separator when stderr is empty, got: {}",
            msg
        );
    }
}
