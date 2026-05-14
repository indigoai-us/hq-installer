use std::fs;
use std::path::Path;

#[tauri::command]
pub fn write_file(path: String, contents: Vec<u8>) -> Result<(), String> {
    let file_path = Path::new(&path);

    // Create parent directories if they don't exist
    if let Some(parent) = file_path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Failed to create directories: {e}"))?;
    }

    fs::write(file_path, &contents).map_err(|e| format!("Failed to write file: {e}"))
}

#[tauri::command]
pub fn home_dir() -> Result<String, String> {
    dirs::home_dir()
        .map(|p| p.to_string_lossy().to_string())
        .ok_or_else(|| "Could not determine home directory".to_string())
}

/// Internal helper (extracted so unit tests can drive symlink creation
/// against tmpdirs without going through the Tauri runtime).
///
/// Removes a pre-existing entry at `link_path` (mirroring `ln -sfn` behavior)
/// so re-running an install can update a symlink whose target moved. Without
/// this, repeated extractions would error with `EEXIST` on the second pass.
fn create_symlink_impl(target: &Path, link_path: &Path) -> Result<(), String> {
    // Ensure parent dir exists — symlinks in nested tar entries
    // (e.g. .codex/output-style.md → ../.claude/output-style.md) need the
    // parent dir before the symlink call succeeds.
    if let Some(parent) = link_path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Failed to create parent dir: {e}"))?;
    }

    // Use symlink_metadata so an existing symlink (even a dangling one)
    // is detected and removed without following it. `metadata()` would
    // follow the link and miss broken symlinks pointing at non-existent
    // targets.
    if fs::symlink_metadata(link_path).is_ok() {
        fs::remove_file(link_path).map_err(|e| format!("Failed to replace existing entry: {e}"))?;
    }

    std::os::unix::fs::symlink(target, link_path)
        .map_err(|e| format!("Failed to create symlink {link_path:?} → {target:?}: {e}"))
}

/// Tauri command: create a symbolic link at `link_path` pointing to `target`.
///
/// Invoked by template-fetcher.ts for tar entries with typeflag '2'. The
/// template ships git symlinks (mode 120000) like `AGENTS.md → .claude/CLAUDE.md`
/// — Tauri's plugin-fs doesn't expose `symlink` from JS, so we route through
/// Rust. POSIX symlinks can point at relative or absolute paths, missing
/// targets, or paths outside the parent dir; we don't validate the target —
/// downstream tooling that walks symlinks is responsible for refusing
/// dangerous ones.
#[tauri::command]
pub fn create_symlink(target: String, link_path: String) -> Result<(), String> {
    create_symlink_impl(Path::new(&target), Path::new(&link_path))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn setup() -> TempDir {
        tempfile::tempdir().expect("tmpdir")
    }

    #[test]
    fn creates_basic_symlink() {
        let dir = setup();
        let link = dir.path().join("AGENTS.md");
        create_symlink_impl(Path::new(".claude/CLAUDE.md"), &link).expect("symlink");

        let meta = fs::symlink_metadata(&link).expect("stat");
        assert!(meta.file_type().is_symlink());
        let target = fs::read_link(&link).expect("read_link");
        assert_eq!(target.to_string_lossy(), ".claude/CLAUDE.md");
    }

    #[test]
    fn creates_parent_dirs_automatically() {
        let dir = setup();
        // Nested entry: parent dir does not exist yet.
        let link = dir.path().join(".codex/output-style.md");
        create_symlink_impl(Path::new("../.claude/output-style.md"), &link).expect("symlink");
        assert!(fs::symlink_metadata(&link)
            .expect("stat")
            .file_type()
            .is_symlink());
    }

    #[test]
    fn replaces_existing_symlink_idempotent() {
        let dir = setup();
        let link = dir.path().join("AGENTS.md");
        // First pass — old target.
        create_symlink_impl(Path::new("old-target"), &link).expect("first symlink");
        // Second pass — new target should overwrite.
        create_symlink_impl(Path::new("new-target"), &link).expect("replace symlink");

        let target = fs::read_link(&link).expect("read_link");
        assert_eq!(target.to_string_lossy(), "new-target");
    }

    #[test]
    fn replaces_existing_regular_file() {
        // Real-world recovery path: an aborted install left a 0-byte regular
        // file at the symlink location (the old buggy behavior). A re-run
        // must replace it cleanly.
        let dir = setup();
        let link = dir.path().join("AGENTS.md");
        fs::write(&link, b"").expect("seed empty file");
        assert!(fs::symlink_metadata(&link)
            .expect("stat")
            .file_type()
            .is_file());

        create_symlink_impl(Path::new(".claude/CLAUDE.md"), &link).expect("symlink");
        assert!(fs::symlink_metadata(&link)
            .expect("stat")
            .file_type()
            .is_symlink());
    }

    #[test]
    fn dangling_symlink_target_is_allowed() {
        // POSIX symlinks can dangle. Test mirrors the tar contract: we
        // forward whatever target string the archive supplies, even if the
        // file doesn't exist yet (the linked content may be extracted later
        // in the same archive or installed by a follow-up step).
        let dir = setup();
        let link = dir.path().join("link");
        create_symlink_impl(Path::new("./does-not-exist-yet"), &link).expect("symlink");
        // The link itself exists (as a symlink), but its target doesn't.
        assert!(fs::symlink_metadata(&link)
            .expect("stat")
            .file_type()
            .is_symlink());
        assert!(fs::metadata(&link).is_err()); // following fails — dangling
    }
}
