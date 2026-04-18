/// Acceptance tests for US-006: git.rs — git2-backed init and initial commit.

#[cfg(test)]
mod git_tests {
    use hq_installer_lib::commands::git::{git_init_impl, git_probe_user_impl};
    use tempfile::TempDir;

    // ─────────────────────────────────────────────────────────────────────────
    // Test 1: git_init creates repo, sets config, makes commit
    // ─────────────────────────────────────────────────────────────────────────

    #[test]
    fn git_init_creates_repo_sets_config_makes_commit() {
        let dir = TempDir::new().expect("tempdir");
        let path = dir.path().to_str().unwrap();
        let name = "Test User";
        let email = "test@example.com";

        let result = git_init_impl(path, name, email);
        assert!(
            result.is_ok(),
            "git_init_impl should return Ok, got: {:?}",
            result
        );

        let sha = result.unwrap();
        assert!(!sha.is_empty(), "returned SHA should be non-empty");

        // .git must exist
        assert!(
            dir.path().join(".git").exists(),
            ".git directory should exist after init"
        );

        // Inspect the repo directly with git2
        let repo = git2::Repository::open(path).expect("open repo");

        // Branch should be 'main'
        let head = repo.head().expect("HEAD");
        let branch_name = head
            .shorthand()
            .expect("HEAD shorthand");
        assert_eq!(branch_name, "main", "default branch should be 'main'");

        // Commit message
        let commit = head.peel_to_commit().expect("peel to commit");
        assert_eq!(
            commit.message().unwrap_or(""),
            "Initial HQ setup via hq-installer",
            "commit message should match"
        );

        // Commit SHA matches returned value
        assert_eq!(
            commit.id().to_string(),
            sha,
            "returned SHA should match HEAD commit"
        );

        // Local config values
        let cfg = repo.config().expect("repo config");
        let cfg_name = cfg.get_string("user.name").expect("user.name");
        let cfg_email = cfg.get_string("user.email").expect("user.email");
        assert_eq!(cfg_name, name, "local user.name should match input");
        assert_eq!(cfg_email, email, "local user.email should match input");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Test 2: git_init is idempotent
    // ─────────────────────────────────────────────────────────────────────────

    #[test]
    fn git_init_is_idempotent() {
        let dir = TempDir::new().expect("tempdir");
        let path = dir.path().to_str().unwrap();

        let first = git_init_impl(path, "Alice", "alice@example.com");
        assert!(first.is_ok(), "first call should succeed: {:?}", first);

        let second = git_init_impl(path, "Alice", "alice@example.com");
        assert!(second.is_ok(), "second call should succeed: {:?}", second);

        assert_eq!(
            first.unwrap(),
            second.unwrap(),
            "both calls should return the same commit SHA (no new commit created)"
        );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Test 3: git_probe_user reads global config (or gracefully returns None)
    // ─────────────────────────────────────────────────────────────────────────

    #[test]
    fn git_probe_user_reads_global_config() {
        let result = git_probe_user_impl();

        assert!(
            result.is_ok(),
            "git_probe_user_impl should not error even with no global config, got: {:?}",
            result
        );

        // We allow either Some(user) or None — the test passes either way.
        // If a GitUser is returned, validate its structure.
        if let Some(user) = result.unwrap() {
            // At least one field should be present when a GitUser is returned.
            assert!(
                user.name.is_some() || user.email.is_some(),
                "GitUser should have at least one field set when returned"
            );
        }
        // Ok(None) is also a valid, expected outcome on machines without git config.
    }
}
