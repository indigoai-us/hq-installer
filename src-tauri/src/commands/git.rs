//! Git operations via the `git2` crate.
//!
//! `git_init`       — creates a repo, sets local config, makes an initial commit.
//! `git_probe_user` — reads the global git config for user.name and user.email.
//!
//! Both operations are idempotent on re-run.

use std::fmt::Display;
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::json;

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/// Global git user identity, suitable for pre-filling UI fields.
#[derive(Debug, Serialize, Deserialize)]
pub struct GitUser {
    pub name: Option<String>,
    pub email: Option<String>,
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/// Serialize an error into the structured JSON string expected by the TS side.
fn git_err(e: impl Display) -> String {
    serde_json::to_string(&json!({
        "code": "GIT_ERROR",
        "message": e.to_string()
    }))
    .unwrap()
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure impl functions (testable without a Tauri runtime)
// ─────────────────────────────────────────────────────────────────────────────

/// Initialise a git repository at `path`, set local user config, and create an
/// initial commit.
///
/// Returns the commit SHA on success.
///
/// **Idempotent:** if `.git` already exists at `path`, the function opens the
/// existing repository and returns the current HEAD SHA without creating a new
/// commit.
pub fn git_init_impl(path: &str, name: &str, email: &str) -> Result<String, String> {
    let dot_git = Path::new(path).join(".git");

    if dot_git.exists() {
        // Repo already initialised — return current HEAD SHA.
        let repo = git2::Repository::open(path).map_err(git_err)?;
        let head_ref = repo.find_reference("refs/heads/main").map_err(git_err)?;
        let commit = head_ref.peel_to_commit().map_err(git_err)?;
        return Ok(commit.id().to_string());
    }

    // --- Init ---
    let repo = git2::Repository::init(path).map_err(git_err)?;

    // Point HEAD at refs/heads/main (default is master on older libgit2).
    repo.set_head("refs/heads/main").map_err(git_err)?;

    // --- Local config: user.name + user.email ---
    {
        let mut cfg = repo.config().map_err(git_err)?;
        cfg.set_str("user.name", name).map_err(git_err)?;
        cfg.set_str("user.email", email).map_err(git_err)?;
    }

    // --- Initial commit on refs/heads/main ---
    let sig = git2::Signature::now(name, email).map_err(git_err)?;

    // Build an empty tree (no files needed for the initial scaffold commit).
    let tree_oid = {
        let tb = repo.treebuilder(None).map_err(git_err)?;
        tb.write().map_err(git_err)?
    };
    let tree = repo.find_tree(tree_oid).map_err(git_err)?;

    let commit_oid = repo
        .commit(
            Some("refs/heads/main"),
            &sig,
            &sig,
            "Initial HQ setup via hq-installer",
            &tree,
            &[], // no parents — this is the root commit
        )
        .map_err(git_err)?;

    Ok(commit_oid.to_string())
}

/// Read the global git config for `user.name` and `user.email`.
///
/// Returns `Ok(None)` when neither field is present in the layered config.
/// Returns `Ok(Some(GitUser { … }))` when at least one field is found (the
/// other field may still be `None`).
/// Only propagates errors that are not `git2::ErrorCode::NotFound`.
pub fn git_probe_user_impl() -> Result<Option<GitUser>, String> {
    let cfg = git2::Config::open_default().map_err(git_err)?;

    let name = match cfg.get_string("user.name") {
        Ok(v) => Some(v),
        Err(e) if e.code() == git2::ErrorCode::NotFound => None,
        Err(e) => return Err(git_err(e)),
    };

    let email = match cfg.get_string("user.email") {
        Ok(v) => Some(v),
        Err(e) if e.code() == git2::ErrorCode::NotFound => None,
        Err(e) => return Err(git_err(e)),
    };

    if name.is_none() && email.is_none() {
        return Ok(None);
    }

    Ok(Some(GitUser { name, email }))
}

// ─────────────────────────────────────────────────────────────────────────────
// Tauri commands
// ─────────────────────────────────────────────────────────────────────────────

/// Initialise a git repository at `path` and return the initial commit SHA.
#[tauri::command]
pub fn git_init(path: String, name: String, email: String) -> Result<String, String> {
    git_init_impl(&path, &name, &email)
}

/// Read the global git user config for UI pre-fill.
#[tauri::command]
pub fn git_probe_user() -> Result<Option<GitUser>, String> {
    git_probe_user_impl()
}
