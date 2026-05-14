//! Acceptance tests for US-006: git.rs — git2-backed init and initial commit.

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
        let branch_name = head.shorthand().expect("HEAD shorthand");
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
    // Test 3: git_init is idempotent on a pre-existing repo on master
    //
    // Regression test for the libgit2 NotFound (-3) error a customer hit when
    // installing into a directory that already had a repo on `master` — the
    // re-open branch hardcoded find_reference("refs/heads/main") instead of
    // resolving HEAD dynamically.
    // ─────────────────────────────────────────────────────────────────────────

    #[test]
    fn git_init_is_idempotent_on_master() {
        let dir = TempDir::new().expect("tempdir");
        let path = dir.path().to_str().unwrap();

        // Seed a repo on `master` with one commit, the way an older `git init`
        // (pre-2.28 default branch change) or a manual `git init -b master`
        // would have left it. Scope the seed phase so `tree` and friends drop
        // before `repo` does — otherwise the borrow checker complains about
        // moving `repo` while it is still borrowed.
        let seed_commit_oid = {
            let repo = git2::Repository::init_opts(
                path,
                git2::RepositoryInitOptions::new().initial_head("master"),
            )
            .expect("init repo on master");
            {
                let mut cfg = repo.config().expect("repo config");
                cfg.set_str("user.name", "Seed").expect("set user.name");
                cfg.set_str("user.email", "seed@example.com")
                    .expect("set user.email");
            }
            let sig = git2::Signature::now("Seed", "seed@example.com").expect("signature");
            let tree_oid = {
                let tb = repo.treebuilder(None).expect("treebuilder");
                tb.write().expect("write tree")
            };
            let tree = repo.find_tree(tree_oid).expect("find tree");
            repo.commit(
                Some("refs/heads/master"),
                &sig,
                &sig,
                "seed commit on master",
                &tree,
                &[],
            )
            .expect("seed commit")
        };

        let result = git_init_impl(path, "Alice", "alice@example.com");
        assert!(
            result.is_ok(),
            "git_init_impl should succeed on a pre-existing repo whose HEAD \
             is master (not main); got: {:?}",
            result
        );
        assert_eq!(
            result.unwrap(),
            seed_commit_oid.to_string(),
            "should return the existing HEAD commit SHA without creating a new commit"
        );

        // Sanity: branch is still master — we resolve HEAD, we don't rewrite it.
        let repo = git2::Repository::open(path).expect("re-open repo");
        let head = repo.head().expect("HEAD");
        assert_eq!(
            head.shorthand().expect("shorthand"),
            "master",
            "pre-existing branch name should be preserved, not rewritten to main"
        );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Test 4: git_probe_user reads global config (or gracefully returns None)
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
