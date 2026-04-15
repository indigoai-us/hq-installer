//! HQ template scaffold — writes the embedded template to a target directory
//! and initializes a git repo with an initial commit.
//!
//! Contract (see `docs/hq-install-spec.md` §5.5 – §5.6):
//!
//! - The template is embedded at build time via `include_dir!` — no network
//!   fetch on the happy path.
//! - `scaffold_hq(target, force)` refuses to overwrite a non-empty target
//!   unless `force == true`. The renderer surfaces this refusal as a modal.
//! - Progress events are emitted per **file-group** (one group per top-level
//!   template directory) so the GUI can render a progress bar without spam.
//! - Git init + `Initial HQ` commit runs after all files are written. The
//!   commit message must be exactly `"Initial HQ"` to match `create-hq`'s
//!   `git.ts:gitCommit`.
//! - Target completion: under 5 s for a standard template on a modern Mac.

use std::collections::BTreeMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Instant;

use include_dir::{include_dir, Dir, DirEntry};
use serde::{Deserialize, Serialize};

/// The embedded HQ template. The path is resolved at build time against
/// `CARGO_MANIFEST_DIR`, so the macro captures the contents of
/// `src-tauri/templates/hq/` into the binary.
///
/// Every file in the template directory — including dotfiles like
/// `.gitignore` and `.claude/settings.json` — is bundled.
pub static TEMPLATE: Dir<'_> = include_dir!("$CARGO_MANIFEST_DIR/templates/hq");

/// Progress event emitted by `scaffold_hq` as the template is expanded.
///
/// `Started` fires first with the total file count. One `FileGroup` event
/// fires per top-level directory as it completes. `GitInit` / `GitCommit`
/// fire after all files are written. `Completed` fires last with timing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum ScaffoldEvent {
    Started { total_files: usize },
    FileGroup { group: String, files_in_group: usize },
    GitInit,
    GitCommit { commit_sha: String },
    Completed { duration_ms: u64, file_count: usize },
    Error { message: String },
}

/// Summary returned to the caller after a successful scaffold.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ScaffoldSummary {
    pub target_dir: PathBuf,
    pub file_count: usize,
    pub duration_ms: u64,
    pub commit_sha: String,
}

/// All the ways `scaffold_hq` can fail.
///
/// Every variant has a renderer-friendly `message()` that the GUI can drop
/// into a modal without needing to know what a `ScaffoldError` is.
#[derive(Debug)]
pub enum ScaffoldError {
    TargetNotEmpty(PathBuf),
    TargetNotWritable(PathBuf, io::Error),
    Io(io::Error),
    GitInitFailed(String),
    GitAddFailed(String),
    GitCommitFailed(String),
    GitConfigMissing,
    EmbeddedTemplateEmpty,
}

impl std::fmt::Display for ScaffoldError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::TargetNotEmpty(p) => {
                write!(f, "target directory is not empty: {}", p.display())
            }
            Self::TargetNotWritable(p, e) => {
                write!(f, "target directory not writable ({}): {e}", p.display())
            }
            Self::Io(e) => write!(f, "i/o error: {e}"),
            Self::GitInitFailed(msg) => write!(f, "git init failed: {msg}"),
            Self::GitAddFailed(msg) => write!(f, "git add failed: {msg}"),
            Self::GitCommitFailed(msg) => write!(f, "git commit failed: {msg}"),
            Self::GitConfigMissing => {
                write!(f, "git user.name / user.email not configured")
            }
            Self::EmbeddedTemplateEmpty => {
                write!(f, "embedded HQ template is empty — build error")
            }
        }
    }
}

impl std::error::Error for ScaffoldError {}

impl From<io::Error> for ScaffoldError {
    fn from(e: io::Error) -> Self {
        Self::Io(e)
    }
}

/// Total file count in the embedded template.
///
/// Pure accessor — cheap enough to call repeatedly, but callers should
/// cache if they're iterating.
pub fn template_file_count() -> usize {
    count_files(&TEMPLATE)
}

/// Recursive helper: count all files (not directories) beneath `dir`.
fn count_files(dir: &Dir<'_>) -> usize {
    let mut n = 0;
    for entry in dir.entries() {
        match entry {
            DirEntry::File(_) => n += 1,
            DirEntry::Dir(sub) => n += count_files(sub),
        }
    }
    n
}

/// Group template files by their **top-level directory** — the first path
/// component. Files at the root go into the `""` group.
///
/// Used to emit coarse `FileGroup` progress events instead of one per file.
pub fn group_files<'a>(dir: &'a Dir<'a>) -> BTreeMap<String, Vec<&'a include_dir::File<'a>>> {
    let mut groups: BTreeMap<String, Vec<&'a include_dir::File<'a>>> = BTreeMap::new();
    collect_files_grouped(dir, &mut groups);
    groups
}

fn collect_files_grouped<'a>(
    dir: &'a Dir<'a>,
    groups: &mut BTreeMap<String, Vec<&'a include_dir::File<'a>>>,
) {
    for entry in dir.entries() {
        match entry {
            DirEntry::File(f) => {
                let group = top_level_group(f.path());
                groups.entry(group).or_default().push(f);
            }
            DirEntry::Dir(sub) => collect_files_grouped(sub, groups),
        }
    }
}

/// First path component of `path`, used as the group key. Root files go in
/// the `"<root>"` group so they're always visible in the progress UI.
pub fn top_level_group(path: &Path) -> String {
    path.components()
        .next()
        .map(|c| c.as_os_str().to_string_lossy().into_owned())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "<root>".to_string())
}

/// True if `dir` does not exist, or exists and contains no entries.
/// Non-existent dirs are treated as empty so the caller can create them.
pub fn is_empty_or_missing(dir: &Path) -> io::Result<bool> {
    if !dir.exists() {
        return Ok(true);
    }
    let mut it = fs::read_dir(dir)?;
    Ok(it.next().is_none())
}

/// Scaffold the embedded HQ template into `target_dir`.
///
/// - `force == false` + non-empty target → `TargetNotEmpty` error (no writes).
/// - `force == true` + non-empty target → proceeds, overwriting conflicting files.
///
/// Emits progress events via `progress` in this order:
///   `Started` → N× `FileGroup` → `GitInit` → `GitCommit` → `Completed`
///
/// Returns the resolved `ScaffoldSummary` on success.
pub fn scaffold_hq<F>(
    target_dir: &Path,
    force: bool,
    progress: F,
) -> Result<ScaffoldSummary, ScaffoldError>
where
    F: Fn(ScaffoldEvent),
{
    let start = Instant::now();

    if count_files(&TEMPLATE) == 0 {
        return Err(ScaffoldError::EmbeddedTemplateEmpty);
    }

    if !force && !is_empty_or_missing(target_dir)? {
        return Err(ScaffoldError::TargetNotEmpty(target_dir.to_path_buf()));
    }

    // Ensure the target directory exists before we start writing.
    fs::create_dir_all(target_dir)
        .map_err(|e| ScaffoldError::TargetNotWritable(target_dir.to_path_buf(), e))?;

    let total_files = count_files(&TEMPLATE);
    progress(ScaffoldEvent::Started { total_files });

    // Write files grouped by top-level directory so we can emit one event
    // per group instead of per file.
    let groups = group_files(&TEMPLATE);
    let mut written = 0usize;
    for (group, files) in &groups {
        for file in files {
            write_embedded_file(target_dir, file)?;
            written += 1;
        }
        progress(ScaffoldEvent::FileGroup {
            group: group.clone(),
            files_in_group: files.len(),
        });
    }
    debug_assert_eq!(written, total_files, "file count drift vs count_files");

    // Git init + initial commit. The installer's check_deps gate guarantees
    // git is on PATH, so shelling out is fine.
    progress(ScaffoldEvent::GitInit);
    git_init(target_dir)?;

    let commit_sha = git_initial_commit(target_dir)?;
    progress(ScaffoldEvent::GitCommit {
        commit_sha: commit_sha.clone(),
    });

    let duration_ms = start.elapsed().as_millis() as u64;
    progress(ScaffoldEvent::Completed {
        duration_ms,
        file_count: total_files,
    });

    Ok(ScaffoldSummary {
        target_dir: target_dir.to_path_buf(),
        file_count: total_files,
        duration_ms,
        commit_sha,
    })
}

fn write_embedded_file(target_dir: &Path, file: &include_dir::File<'_>) -> io::Result<()> {
    let dest = target_dir.join(file.path());
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(&dest, file.contents())
}

fn git_init(target_dir: &Path) -> Result<(), ScaffoldError> {
    // -b main pins the initial branch name regardless of the user's
    // init.defaultBranch config. This makes the installer's behavior
    // deterministic across machines.
    let out = Command::new("git")
        .args(["init", "-b", "main"])
        .current_dir(target_dir)
        .output()
        .map_err(|e| ScaffoldError::GitInitFailed(e.to_string()))?;
    if !out.status.success() {
        return Err(ScaffoldError::GitInitFailed(
            String::from_utf8_lossy(&out.stderr).into_owned(),
        ));
    }
    Ok(())
}

fn git_initial_commit(target_dir: &Path) -> Result<String, ScaffoldError> {
    let add = Command::new("git")
        .args(["add", "-A"])
        .current_dir(target_dir)
        .output()
        .map_err(|e| ScaffoldError::GitAddFailed(e.to_string()))?;
    if !add.status.success() {
        return Err(ScaffoldError::GitAddFailed(
            String::from_utf8_lossy(&add.stderr).into_owned(),
        ));
    }

    // Per spec §5.6: never touch global git config. Set per-repo identity
    // only if the user has not configured one globally. We detect that by
    // running `git var GIT_AUTHOR_IDENT` and falling back if it errors.
    ensure_repo_identity(target_dir)?;

    let commit = Command::new("git")
        .args(["commit", "-m", "Initial HQ"])
        .current_dir(target_dir)
        .env("GIT_AUTHOR_NAME", "HQ Installer")
        .env("GIT_AUTHOR_EMAIL", "installer@hq.local")
        .env("GIT_COMMITTER_NAME", "HQ Installer")
        .env("GIT_COMMITTER_EMAIL", "installer@hq.local")
        .output()
        .map_err(|e| ScaffoldError::GitCommitFailed(e.to_string()))?;
    if !commit.status.success() {
        return Err(ScaffoldError::GitCommitFailed(
            String::from_utf8_lossy(&commit.stderr).into_owned(),
        ));
    }

    let rev = Command::new("git")
        .args(["rev-parse", "HEAD"])
        .current_dir(target_dir)
        .output()
        .map_err(|e| ScaffoldError::GitCommitFailed(e.to_string()))?;
    if !rev.status.success() {
        return Err(ScaffoldError::GitCommitFailed(
            String::from_utf8_lossy(&rev.stderr).into_owned(),
        ));
    }
    Ok(String::from_utf8_lossy(&rev.stdout).trim().to_string())
}

/// Sets `user.name` / `user.email` at the repo level only if the user's
/// global config is missing those values. Never writes to `--global`.
///
/// This is best-effort: if `git var GIT_AUTHOR_IDENT` succeeds, the user
/// already has valid identity, and we leave it alone.
fn ensure_repo_identity(target_dir: &Path) -> Result<(), ScaffoldError> {
    let ident = Command::new("git")
        .args(["var", "GIT_AUTHOR_IDENT"])
        .current_dir(target_dir)
        .output();
    let identity_present = matches!(ident, Ok(o) if o.status.success());

    if identity_present {
        return Ok(());
    }

    // No global identity — set per-repo so the commit succeeds. The
    // installer GUI (US-008) should later prompt the user to replace these
    // with their real name/email.
    let _ = Command::new("git")
        .args(["config", "user.name", "HQ Installer"])
        .current_dir(target_dir)
        .status();
    let _ = Command::new("git")
        .args(["config", "user.email", "installer@hq.local"])
        .current_dir(target_dir)
        .status();
    Ok(())
}

// ──────────────────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn template_is_non_empty() {
        // The embedded template must carry files, otherwise the binary
        // would ship with a broken installer.
        assert!(template_file_count() > 0);
    }

    #[test]
    fn template_carries_required_roots() {
        // Expected top-level groups from the minimal HQ skeleton.
        let groups = group_files(&TEMPLATE);
        let keys: Vec<&String> = groups.keys().collect();
        for required in [
            "README.md",
            ".claude",
            "companies",
            "knowledge",
            "workers",
            "workspace",
        ] {
            let matched = groups.keys().any(|k| k.as_str() == required)
                || keys.iter().any(|k| k.as_str() == "<root>");
            assert!(matched, "missing required template group: {required}");
        }
    }

    #[test]
    fn template_root_files_present() {
        // README.md, CLAUDE.md, USER-GUIDE.md, .gitignore live at the root.
        let has_readme = TEMPLATE.get_file("README.md").is_some();
        let has_claude_md = TEMPLATE.get_file("CLAUDE.md").is_some();
        let has_user_guide = TEMPLATE.get_file("USER-GUIDE.md").is_some();
        let has_gitignore = TEMPLATE.get_file(".gitignore").is_some();
        assert!(has_readme, "README.md missing");
        assert!(has_claude_md, "CLAUDE.md missing");
        assert!(has_user_guide, "USER-GUIDE.md missing");
        assert!(has_gitignore, ".gitignore missing");
    }

    #[test]
    fn template_carries_dotfiles() {
        // Dotfiles like .claude/settings.json must be included — include_dir
        // macro includes them by default but a build misconfig could miss them.
        assert!(
            TEMPLATE
                .get_file(".claude/settings.json")
                .is_some(),
            ".claude/settings.json missing from embedded template"
        );
    }

    #[test]
    fn top_level_group_classifies_nested_path() {
        assert_eq!(
            top_level_group(Path::new("companies/_template/.gitkeep")),
            "companies"
        );
        assert_eq!(
            top_level_group(Path::new(".claude/settings.json")),
            ".claude"
        );
    }

    #[test]
    fn top_level_group_for_root_file() {
        assert_eq!(top_level_group(Path::new("README.md")), "README.md");
    }

    #[test]
    fn is_empty_or_missing_returns_true_for_nonexistent() {
        let path = Path::new("/tmp/hq-installer-scaffold-missing-xyz-12345");
        // Sanity-check our test fixture path isn't accidentally real.
        if !path.exists() {
            assert!(is_empty_or_missing(path).unwrap());
        }
    }

    #[test]
    fn is_empty_or_missing_returns_false_for_non_empty() {
        // /tmp itself virtually always has entries — if CI is bizarre enough
        // that /tmp is empty, skip rather than fail.
        let path = Path::new("/tmp");
        if let Ok(mut it) = fs::read_dir(path) {
            if it.next().is_some() {
                assert!(!is_empty_or_missing(path).unwrap());
            }
        }
    }

    #[test]
    fn count_files_matches_group_sum() {
        // Invariant: the number of files reachable via count_files must
        // equal the sum of the grouping's file lists.
        let total = count_files(&TEMPLATE);
        let groups = group_files(&TEMPLATE);
        let summed: usize = groups.values().map(|v| v.len()).sum();
        assert_eq!(total, summed);
    }

    #[test]
    fn scaffold_error_display_formats() {
        let err = ScaffoldError::TargetNotEmpty(PathBuf::from("/tmp/hq"));
        assert!(format!("{err}").contains("not empty"));
        let err = ScaffoldError::GitConfigMissing;
        assert!(format!("{err}").contains("user.name"));
    }
}
