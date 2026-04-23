/// Acceptance tests for US-003: Rust deps.rs probe and install commands.
///
/// Tests use `check_dep_in` (a thin wrapper around the public `check_dep`
/// logic that accepts an explicit search path) to stay fully thread-safe —
/// no global PATH mutation is needed, so tests can run in parallel.

#[cfg(test)]
mod deps_tests {
    use hq_installer_lib::commands::deps::{
        cancel_install, check_dep_in, extended_search_path, extended_search_path_in,
        format_install_error, format_path_log, format_shell_probe_log, is_deps_debug_enabled,
        register_cancel_handle, ShellProbeOutcome,
    };
    use serial_test::serial;
    use std::fs;
    use std::os::unix::fs::PermissionsExt;
    use std::path::Path;
    use tempfile::TempDir;

    /// Create a fake executable named `name` inside `parent`, creating any
    /// missing parent directories. The script prints `<name> version 1.2.3`
    /// and exits 0 — same semantics as `make_fake_bin` but accepts an
    /// arbitrary directory path so tests can seed fixture trees that match
    /// nvm/fnm/volta/pnpm on-disk layouts.
    fn make_fake_bin_at(parent: &Path, name: &str) {
        fs::create_dir_all(parent).unwrap();
        let path = parent.join(name);
        fs::write(
            &path,
            format!("#!/bin/sh\necho '{} version 1.2.3'\n", name),
        )
        .unwrap();
        let mut perms = fs::metadata(&path).unwrap().permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&path, perms).unwrap();
    }

    /// Create a temporary directory containing a minimal shell script that:
    ///   - prints `<name> version 1.2.3` to stdout
    ///   - exits 0
    fn make_fake_bin(dir: &TempDir, name: &str) {
        make_fake_bin_at(dir.path(), name);
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
    // Test 11a: extended_search_path_in picks up a binary installed under
    //           ~/.nvm/versions/node/<v>/bin — the primary nvm layout. This
    //           is the fix for qmd/claude detection when the shell-login
    //           PATH probe returns empty (GUI launch without SHELL).
    // ─────────────────────────────────────────────────────────────────────────
    #[test]
    fn test_extended_search_path_finds_nvm_tool() {
        let home = TempDir::new().unwrap();
        let node_bin = home
            .path()
            .join(".nvm")
            .join("versions")
            .join("node")
            .join("v22.17.0")
            .join("bin");
        make_fake_bin_at(&node_bin, "fake-tool");

        let path = extended_search_path_in(Some(home.path()));
        let status = check_dep_in("fake-tool", &path);

        assert!(status.installed, "fake-tool under nvm should be detected");
        let resolved = status.path.expect("path should be populated");
        assert!(
            resolved.to_string_lossy().contains(".nvm/versions/node/v22.17.0/bin"),
            "resolved path should be the nvm bin dir, got: {:?}",
            resolved
        );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Test 11b: extended_search_path_in picks up a binary installed under
    //           ~/.fnm/node-versions/<v>/installation/bin — fnm's default
    //           on-disk layout differs from nvm.
    // ─────────────────────────────────────────────────────────────────────────
    #[test]
    fn test_extended_search_path_finds_fnm_tool() {
        let home = TempDir::new().unwrap();
        let node_bin = home
            .path()
            .join(".fnm")
            .join("node-versions")
            .join("v20.10.0")
            .join("installation")
            .join("bin");
        make_fake_bin_at(&node_bin, "fake-tool");

        let path = extended_search_path_in(Some(home.path()));
        let status = check_dep_in("fake-tool", &path);

        assert!(status.installed, "fake-tool under fnm should be detected");
        let resolved = status.path.expect("path should be populated");
        assert!(
            resolved.to_string_lossy().contains(".fnm/node-versions"),
            "resolved path should be under the fnm tree, got: {:?}",
            resolved
        );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Test 11c: extended_search_path_in picks up a binary installed under
    //           ~/.volta/bin — volta exposes a single shim dir (no per-version
    //           enumeration needed).
    // ─────────────────────────────────────────────────────────────────────────
    #[test]
    fn test_extended_search_path_finds_volta_tool() {
        let home = TempDir::new().unwrap();
        let volta_bin = home.path().join(".volta").join("bin");
        make_fake_bin_at(&volta_bin, "fake-tool");

        let path = extended_search_path_in(Some(home.path()));
        let status = check_dep_in("fake-tool", &path);

        assert!(status.installed, "fake-tool under volta should be detected");
        let resolved = status.path.expect("path should be populated");
        assert!(
            resolved.to_string_lossy().contains(".volta/bin"),
            "resolved path should be the volta shim dir, got: {:?}",
            resolved
        );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Test 11d: extended_search_path_in picks up a binary installed under
    //           ~/Library/pnpm — pnpm's default macOS global-bin location.
    // ─────────────────────────────────────────────────────────────────────────
    #[test]
    fn test_extended_search_path_finds_pnpm_tool() {
        let home = TempDir::new().unwrap();
        let pnpm_bin = home.path().join("Library").join("pnpm");
        make_fake_bin_at(&pnpm_bin, "fake-tool");

        let path = extended_search_path_in(Some(home.path()));
        let status = check_dep_in("fake-tool", &path);

        assert!(status.installed, "fake-tool under pnpm should be detected");
        let resolved = status.path.expect("path should be populated");
        assert!(
            resolved.to_string_lossy().contains("Library/pnpm"),
            "resolved path should be the pnpm global bin, got: {:?}",
            resolved
        );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Test 11e: Regression — when NONE of the 4 version managers are
    //           present under the fixture home, the function must still
    //           return a non-empty PATH with the static macOS extras. This
    //           guards against the VM-enumeration code accidentally
    //           short-circuiting the existing composition.
    // ─────────────────────────────────────────────────────────────────────────
    #[test]
    fn test_extended_search_path_regression_no_version_managers() {
        let home = TempDir::new().unwrap();
        // Note: we deliberately create nothing — the fixture home is empty.

        let path = extended_search_path_in(Some(home.path()));

        assert!(
            !path.is_empty(),
            "extended_search_path_in should not be empty when no VMs present"
        );
        assert!(
            path.contains("/opt/homebrew/bin"),
            "static extras should still be present, got: {}",
            path
        );
        assert!(
            path.contains("/usr/local/bin"),
            "static extras should still be present, got: {}",
            path
        );
    }

    /// Test 11f: When multiple nvm Node versions exist under the fixture home,
    ///           the latest version's bin dir must appear FIRST in PATH so that
    ///           `which::which_in` resolves to the newest toolchain. Guards
    ///           against the filesystem-order nondeterminism flagged in codex
    ///           review of commit 9f57dc2.
    #[test]
    fn test_extended_search_path_nvm_picks_newest_version() {
        let home = TempDir::new().unwrap();
        let nvm_root = home.path().join(".nvm").join("versions").join("node");

        // Seed two versions. Both have a `bin/node` executable; the test
        // asserts which one which_in resolves to.
        make_fake_bin_at(&nvm_root.join("v18.0.0").join("bin"), "nvm-test-tool");
        make_fake_bin_at(&nvm_root.join("v22.17.0").join("bin"), "nvm-test-tool");

        let path = extended_search_path_in(Some(home.path()));

        // v22 must appear before v18 in the colon-joined PATH.
        let v22_pos = path.find("v22.17.0").expect("v22 dir should be in PATH");
        let v18_pos = path.find("v18.0.0").expect("v18 dir should be in PATH");
        assert!(
            v22_pos < v18_pos,
            "v22.17.0 should precede v18.0.0 in PATH for correct version selection, got: {}",
            path
        );

        // And which_in should resolve to the v22 binary.
        let status = check_dep_in("nvm-test-tool", &path);
        assert!(status.installed);
        let resolved = status.path.expect("path should be populated");
        assert!(
            resolved.to_string_lossy().contains("v22.17.0"),
            "which_in should pick the newest version, got: {:?}",
            resolved
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

    // ═════════════════════════════════════════════════════════════════════════
    // US-002: env-gated diagnostic logging
    // ─────────────────────────────────────────────────────────────────────────
    // Tests below cover the [hq-deps] log contract: a single stderr line per
    // probe/PATH-composition when HQ_INSTALLER_DEBUG_DEPS=1, silent otherwise.
    // The formatters are pure functions so most assertions need no stderr
    // capture. Only the end-to-end test spawns a subprocess — necessary because
    // shell_login_path() is cached via OnceLock per-process.
    // ═════════════════════════════════════════════════════════════════════════

    // ─────────────────────────────────────────────────────────────────────────
    // Test A: NonZeroExit formatter renders 'exit=<code>' with the shell path.
    //         This is the path hit when $SHELL points at /usr/bin/false on
    //         macOS (exit=1) — the installer's only supported platform.
    // ─────────────────────────────────────────────────────────────────────────
    #[test]
    fn test_format_shell_probe_log_nonzero_exit_includes_exit() {
        let msg = format_shell_probe_log(
            "/usr/bin/false",
            &ShellProbeOutcome::NonZeroExit { code: 1 },
        );
        assert!(msg.contains("[hq-deps]"), "must include tag, got: {}", msg);
        assert!(
            msg.contains("exit="),
            "must include exit=<code>: {}",
            msg
        );
        assert!(
            msg.contains("/usr/bin/false"),
            "must include shell path: {}",
            msg
        );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Test B: SpawnError formatter marks spawn failure distinctly.
    // ─────────────────────────────────────────────────────────────────────────
    #[test]
    fn test_format_shell_probe_log_spawn_error_includes_spawn() {
        let msg = format_shell_probe_log(
            "/no/such/shell",
            &ShellProbeOutcome::SpawnError {
                msg: "No such file".into(),
            },
        );
        assert!(msg.contains("[hq-deps]"));
        assert!(
            msg.contains("spawn=error"),
            "spawn failures must be tagged spawn=error, got: {}",
            msg
        );
        assert!(msg.contains("No such file"), "must include spawn error detail");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Test C: Success formatter reports exit=0 and byte count.
    // ─────────────────────────────────────────────────────────────────────────
    #[test]
    fn test_format_shell_probe_log_success_includes_bytes() {
        let msg = format_shell_probe_log(
            "/bin/zsh",
            &ShellProbeOutcome::Success { bytes: 512 },
        );
        assert!(msg.contains("[hq-deps]"));
        assert!(msg.contains("exit=0"));
        assert!(msg.contains("bytes=512"));
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Test D: EmptyOutput is flagged 'empty=true' so support docs can
    //         distinguish it from the normal success case.
    // ─────────────────────────────────────────────────────────────────────────
    #[test]
    fn test_format_shell_probe_log_empty_output_flagged() {
        let msg = format_shell_probe_log("/bin/sh", &ShellProbeOutcome::EmptyOutput);
        assert!(
            msg.contains("empty=true"),
            "empty case must be distinguishable, got: {}",
            msg
        );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Test E: PATH log emits tag, per-source counts, and the full PATH so
    //         support paste-backs show both composition + content.
    // ─────────────────────────────────────────────────────────────────────────
    #[test]
    fn test_format_path_log_includes_counts_and_path() {
        let msg = format_path_log("/usr/bin:/bin", (1, 4, 0, 2));
        assert!(msg.contains("[hq-deps]"));
        assert!(msg.contains("shell=1"));
        assert!(msg.contains("extras=4"));
        assert!(msg.contains("home=0"));
        assert!(msg.contains("vm=2"));
        assert!(msg.contains("PATH=/usr/bin:/bin"));
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Test F: PATH log truncates at 500 chars so a bloated PATH (colon-joined
    //         nvm versions can easily exceed 2 KB) doesn't flood stderr.
    // ─────────────────────────────────────────────────────────────────────────
    #[test]
    fn test_format_path_log_truncates_long_path() {
        let long = "/a".repeat(1000); // 2000 chars
        let msg = format_path_log(&long, (0, 0, 0, 0));
        // Prefix "[hq-deps] extended_search_path shell=0 extras=0 home=0 vm=0 PATH="
        // plus up to 500 chars of path — total well under 650.
        assert!(
            msg.len() < 650,
            "message should be truncated, got length {}",
            msg.len()
        );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Test G: env gate is strict — only the literal string "1" enables logs.
    //         Anything else (including "true", "0", unset) returns false so
    //         production builds stay silent unless the user explicitly opts in.
    //         Marked #[serial] because it mutates the process-global env var
    //         that other tests (Test H) also read.
    // ─────────────────────────────────────────────────────────────────────────
    #[test]
    #[serial]
    fn test_is_deps_debug_enabled_honors_one_only() {
        // Restore prior env on exit so we don't leak state between tests.
        struct EnvGuard(Option<String>);
        impl Drop for EnvGuard {
            fn drop(&mut self) {
                match &self.0 {
                    Some(v) => std::env::set_var("HQ_INSTALLER_DEBUG_DEPS", v),
                    None => std::env::remove_var("HQ_INSTALLER_DEBUG_DEPS"),
                }
            }
        }
        let _g = EnvGuard(std::env::var("HQ_INSTALLER_DEBUG_DEPS").ok());

        std::env::set_var("HQ_INSTALLER_DEBUG_DEPS", "1");
        assert!(is_deps_debug_enabled(), "must be true when =1");

        std::env::set_var("HQ_INSTALLER_DEBUG_DEPS", "0");
        assert!(!is_deps_debug_enabled(), "must be false when =0");

        std::env::set_var("HQ_INSTALLER_DEBUG_DEPS", "true");
        assert!(
            !is_deps_debug_enabled(),
            "must be false when =true (strict == '1')"
        );

        std::env::remove_var("HQ_INSTALLER_DEBUG_DEPS");
        assert!(!is_deps_debug_enabled(), "must be false when unset");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Test H: End-to-end stderr capture — PRD acceptance criterion #5.
    //
    // `shell_login_path()` is cached via OnceLock per-process, so to exercise
    // both the enabled-AND-fake-shell path and the disabled path we spawn a
    // fresh test binary per scenario via `cargo test`. Each subprocess runs
    // the dedicated `helper_emit_shell_probe_log` test which triggers the
    // real probe; we capture its stderr and assert on the `[hq-deps]` line.
    //
    // Marked #[serial] to play nicely with Test G (both mutate env on this
    // process) — the spawned cargo processes get their own env regardless.
    // ─────────────────────────────────────────────────────────────────────────
    #[test]
    #[serial]
    fn test_shell_probe_log_reaches_stderr_only_when_enabled() {
        let exe = std::env::current_exe().expect("current_exe");

        // Case 1: env var set + SHELL=/usr/bin/false → stderr must contain
        // [hq-deps] and "exit=" (the NonZeroExit outcome renders "exit=<code>").
        // Note: PRD wording referenced /bin/false, but macOS only ships the
        // binary at /usr/bin/false. Since the installer is macOS-only, that's
        // the correct path to trigger the NonZeroExit log branch.
        let enabled = std::process::Command::new(&exe)
            .args([
                "--exact",
                "--nocapture",
                "deps_tests::helper_emit_shell_probe_log",
            ])
            .env("HQ_INSTALLER_DEBUG_DEPS", "1")
            .env("SHELL", "/usr/bin/false")
            .output()
            .expect("failed to spawn helper test (enabled)");
        let enabled_stderr = String::from_utf8_lossy(&enabled.stderr);
        assert!(
            enabled.status.success(),
            "helper test failed (enabled case): stdout={} stderr={}",
            String::from_utf8_lossy(&enabled.stdout),
            enabled_stderr
        );
        assert!(
            enabled_stderr.contains("[hq-deps]"),
            "expected [hq-deps] tag in stderr when enabled, got: {}",
            enabled_stderr
        );
        assert!(
            enabled_stderr.contains("exit="),
            "expected 'exit=' marker in stderr when shell=/usr/bin/false, got: {}",
            enabled_stderr
        );

        // Case 2: env var unset → zero [hq-deps] lines in stderr.
        let disabled = std::process::Command::new(&exe)
            .args([
                "--exact",
                "--nocapture",
                "deps_tests::helper_emit_shell_probe_log",
            ])
            .env_remove("HQ_INSTALLER_DEBUG_DEPS")
            .env("SHELL", "/usr/bin/false")
            .output()
            .expect("failed to spawn helper test (disabled)");
        let disabled_stderr = String::from_utf8_lossy(&disabled.stderr);
        assert!(
            disabled.status.success(),
            "helper test failed (disabled case): stderr={}",
            disabled_stderr
        );
        assert!(
            !disabled_stderr.contains("[hq-deps]"),
            "no [hq-deps] line should appear when env var is unset, got: {}",
            disabled_stderr
        );
    }

    /// Helper test harness for `test_shell_probe_log_reaches_stderr_only_when_enabled`.
    ///
    /// Calls `extended_search_path_in(Some(tmp_home))`, which internally invokes
    /// the cached `shell_login_path()`. Running inside a fresh subprocess means
    /// the OnceLock is untouched, so the probe actually fires and (when the
    /// env var is set) emits its `[hq-deps]` line.
    ///
    /// Not a real acceptance test — just scaffolding. The outer test spawns
    /// this by exact name and captures its stderr.
    #[test]
    fn helper_emit_shell_probe_log() {
        // Use an empty tmp home so we don't depend on the spawning developer's
        // version-manager setup polluting the log.
        let home = TempDir::new().unwrap();
        let _ = extended_search_path_in(Some(home.path()));
    }
}
