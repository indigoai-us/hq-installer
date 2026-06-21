use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt as _;
#[cfg(windows)]
use std::os::windows::process::CommandExt as _;
#[cfg(windows)]
use std::path::Component;
#[cfg(windows)]
use std::process::Command;

/// Win32 CREATE_NO_WINDOW — keeps the `cmd /C mklink` fallback from flashing a
/// console window during template extraction.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// `ERROR_PRIVILEGE_NOT_HELD` (Win32 1314). `CreateSymbolicLinkW` returns this
/// when the process holds neither `SeCreateSymbolicLinkPrivilege` nor an
/// elevated token AND Developer Mode is off — i.e. the default state for a
/// non-admin user who hasn't toggled Developer Mode. This is the single most
/// common install failure on Windows, so we special-case it for the no-admin
/// fallback path below.
#[cfg(windows)]
const ERROR_PRIVILEGE_NOT_HELD: i32 = 1314;

/// Marker prefix stamped onto the error string when a symlink — AND its
/// no-admin fallback — both fail for privilege reasons. `07-template.tsx`
/// matches this token to swap the generic error screen for the "Enable
/// Developer Mode / run as administrator, then Retry" recovery flow instead of
/// dumping a raw OS error on the user.
#[cfg(windows)]
pub const PRIVILEGE_ERROR_TAG: &str = "HQ_SYMLINK_PRIVILEGE";

#[tauri::command]
pub fn write_file(
    path: String,
    contents: Vec<u8>,
    install_root: String,
    mode: Option<u32>,
) -> Result<(), String> {
    let file_path = guard_relative_path_under_root(&path, &install_root)?;

    if let Some(parent) = file_path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Failed to create directories: {e}"))?;
    }

    atomic_write(&file_path, &contents)?;

    #[cfg(not(unix))]
    let _ = mode;

    #[cfg(unix)]
    if let Some(mode) = mode {
        fs::set_permissions(&file_path, fs::Permissions::from_mode(mode & 0o7777))
            .map_err(|e| format!("Failed to set file permissions: {e}"))?;
    }

    Ok(())
}

#[tauri::command]
pub fn make_dir(path: String, install_root: String) -> Result<(), String> {
    let dir_path = if has_unsafe_relative_prefix(&path) {
        guard_absolute_path_under_root(&path, &install_root)?
    } else {
        guard_relative_path_under_root(&path, &install_root)?
    };

    fs::create_dir_all(&dir_path)
        .map_err(|e| format!("Failed to create directory {}: {e}", dir_path.display()))
}

#[tauri::command]
pub fn read_text_file(path: String, install_root: String) -> Result<String, String> {
    let file_path = if has_unsafe_relative_prefix(&path) {
        guard_absolute_path_under_root(&path, &install_root)?
    } else {
        guard_relative_path_under_root(&path, &install_root)?
    };

    fs::read_to_string(&file_path)
        .map_err(|e| format!("Failed to read file {}: {e}", file_path.display()))
}

#[tauri::command]
pub fn home_dir() -> Result<String, String> {
    dirs::home_dir()
        .map(|p| p.to_string_lossy().to_string())
        .ok_or_else(|| "Could not determine home directory".to_string())
}

/// Remove an entry that's blocking a symlink create. Handles the three
/// Windows shapes the previous "always remove_file" branch tripped over
/// on `--overwrite` reinstalls:
///   - regular directory (from a prior non-symlink extract) → remove_dir_all
///   - directory symlink / junction → remove_dir (NOT remove_file; Win32
///     classifies dir reparse points as directories for delete APIs and
///     remove_file fails with ERROR_ACCESS_DENIED)
///   - file or file symlink → remove_file
///
/// In all three cases, clear the read-only attribute first — hq templates
/// occasionally include checked-in read-only marker files, and the
/// previous install may have left files with the read-only bit set, which
/// blocks remove_* with the same ACCESS_DENIED.
#[cfg(windows)]
fn remove_existing_entry(path: &Path, md: &fs::Metadata) -> std::io::Result<()> {
    // Best-effort: clear the readonly attribute so remove_* can proceed.
    // Ignore errors — the subsequent remove_* call will surface the real
    // problem if the file is still locked / ACL-restricted. On Windows the
    // readonly bit is the only thing this touches; on Unix the wider
    // clippy::permissions-set-readonly-false warning is about world-write
    // semantics, which isn't relevant here (this command only runs from
    // the symlink-extract path, in user-owned dirs).
    #[allow(clippy::permissions_set_readonly_false)]
    {
        let mut perms = md.permissions();
        if perms.readonly() {
            perms.set_readonly(false);
            let _ = fs::set_permissions(path, perms);
        }
    }

    let ft = md.file_type();
    // Directory symlinks AND junctions both report is_symlink() = true on
    // Windows, but `remove_file` rejects them with ACCESS_DENIED. They must
    // go through `remove_dir`, which unlinks the reparse point without
    // recursing into the target.
    if ft.is_symlink() {
        // Probe the underlying type: if the target resolves to a dir, the
        // reparse point is a dir symlink/junction and must use remove_dir.
        // If the target resolves to a file (or is broken), remove_file works.
        let target_is_dir = fs::metadata(path).map(|m| m.is_dir()).unwrap_or(false);
        if target_is_dir {
            fs::remove_dir(path)
        } else {
            fs::remove_file(path)
        }
    } else if ft.is_dir() {
        fs::remove_dir_all(path)
    } else {
        fs::remove_file(path)
    }
}

/// Internal helper (extracted so unit tests can drive symlink creation
/// against tmpdirs without going through the Tauri runtime).
///
/// Removes a pre-existing entry at `link_path` (mirroring `ln -sfn` behavior)
/// so re-running an install can update a symlink whose target moved. Without
/// this, repeated extractions would error with `EEXIST` on the second pass.
#[cfg(unix)]
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

/// Internal helper (extracted so unit tests can drive symlink creation
/// against tmpdirs without going through the Tauri runtime).
///
/// Removes a pre-existing entry at `link_path` (mirroring `ln -sfn` behavior)
/// so re-running an install can update a symlink whose target moved. Without
/// this, repeated extractions would error with `EEXIST` on the second pass.
#[cfg(windows)]
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
    if let Ok(md) = fs::symlink_metadata(link_path) {
        remove_existing_entry(link_path, &md)
            .map_err(|e| format!("Failed to replace existing entry: {e}"))?;
    }

    // Windows file symlink. Requires either Developer Mode enabled in
    // Settings → Privacy & security → For developers, or the
    // SeCreateSymbolicLinkPrivilege right, or an elevated process. Without
    // one of those the call returns ERROR_PRIVILEGE_NOT_HELD. Template
    // extraction (the only caller) surfaces this to the wizard, which then
    // points the user at the Developer Mode toggle.
    //
    // CRITICAL: convert forward slashes to backslashes in the target.
    // The tar archive stores POSIX symlink targets like
    // `core/docs/hq/MIGRATION.md` or `.claude/CLAUDE.md`. Windows reparse
    // points (created by CreateSymbolicLinkW under symlink_file) require
    // BACKSLASH path separators — a relative target containing `/` produces
    // a reparse point that Windows cannot resolve. The symlink LOOKS valid
    // (`Get-Item` shows LinkType=SymbolicLink, the right Target string), but
    // EVERY read fails with "The filename, directory name, or volume label
    // syntax is incorrect" — which Node/Bun surface as ENOENT. That crashed
    // `qmd` indexing at the Verify step on `MIGRATION.md` even though the
    // target file existed. Verified: identical symlink with `\` target reads
    // fine; with `/` it fails. (The /-vs-\ is the only variable.)
    let win_target: std::path::PathBuf = target.to_string_lossy().replace('/', "\\").into();

    // Windows bakes the file-vs-directory distinction into the symlink at
    // CREATE time (symlink_file vs symlink_dir) — unlike POSIX, where one
    // symlink works for either. A file-symlink pointing at a directory does
    // NOT resolve. The HQ template ships BOTH kinds:
    //   - file targets:  AGENTS.md → .claude/CLAUDE.md
    //   - dir targets:   .agents/skills → ../.claude/skills,
    //                    .codex/claude → ../.claude,
    //                    companies/_template/.obsidian → ../../.obsidian
    // So we must probe the resolved target and pick the matching call.
    //
    // The target is relative to the LINK's parent dir, so resolve it there
    // to classify. If the target doesn't exist yet (forward-reference within
    // the same archive) we fall back to symlink_file — matches the common
    // case (most HQ symlinks are file targets) and a later pass can't fix it
    // anyway since the type is fixed at create time. The known dir symlinks
    // all point at dirs that are extracted before them, so the probe is
    // reliable in practice.
    let resolved_target = link_path
        .parent()
        .map(|p| p.join(&win_target))
        .unwrap_or_else(|| win_target.clone());
    let target_is_dir = std::fs::metadata(&resolved_target)
        .map(|m| m.is_dir())
        .unwrap_or(false);

    let result = if target_is_dir {
        std::os::windows::fs::symlink_dir(&win_target, link_path)
    } else {
        std::os::windows::fs::symlink_file(&win_target, link_path)
    };

    match result {
        Ok(()) => Ok(()),
        // No symlink privilege (Developer Mode off, process not elevated).
        // Self-correct WITHOUT requiring admin — this matches the installer's
        // deliberate no-UAC design (PATH writes are HKCU, MSI installs
        // per-user). Two fallbacks, both privilege-free for any user:
        //   - dir target  → directory junction (reparse point). `mklink /J`
        //                    needs no special right, and git/qmd/Node resolve
        //                    junctions transparently as if they were dirs.
        //   - file target → copy the target's bytes to the link path. HQ's
        //                    file symlinks point at static template scaffolding
        //                    (e.g. AGENTS.md → .claude/CLAUDE.md), so a copy is
        //                    behaviorally equivalent for install + indexing.
        // `resolved_target` is the link's parent joined with the (already
        // backslash-normalized) relative target — absolute but possibly
        // carrying `..` segments, which `lexical_absolute` collapses.
        Err(e) if e.raw_os_error() == Some(ERROR_PRIVILEGE_NOT_HELD) => {
            let fallback = if target_is_dir {
                create_junction(&resolved_target, link_path)
            } else {
                copy_file_fallback(&resolved_target, link_path)
            };
            let kind = if target_is_dir { "dir" } else { "file" };
            fallback.map_err(|fallback_err| {
                // Even the no-admin fallback could not recover (e.g. a file
                // symlink whose target has not been extracted yet). Tag the
                // message so the wizard offers the Developer Mode flow.
                format!(
                    "{PRIVILEGE_ERROR_TAG}: cannot create {kind} link {link_path:?} → {win_target:?} \
                     without Developer Mode or administrator rights (fallback failed: {fallback_err})"
                )
            })
        }
        Err(e) => Err(format!(
            "Failed to create {} symlink {link_path:?} → {win_target:?}: {e}",
            if target_is_dir { "dir" } else { "file" }
        )),
    }
}

/// Collapse `.` and `..` segments out of `path` lexically (no disk access),
/// preserving the Windows prefix (`C:`) and root. `mklink /J` mishandles a
/// target argument that still contains `..` components, so we hand it a clean
/// absolute path. Pure string math — the caller is responsible for passing an
/// already-absolute path (we never resolve relative paths against CWD here).
#[cfg(windows)]
fn lexical_absolute(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for comp in path.components() {
        match comp {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            Component::Prefix(p) => out.push(p.as_os_str()),
            Component::RootDir => out.push(comp.as_os_str()),
            Component::Normal(s) => out.push(s),
        }
    }
    out
}

/// Create a directory junction at `link_path` pointing to `target`, via the
/// `cmd /C mklink /J` builtin. Junctions are reparse points that — unlike
/// directory symlinks — require NO privilege, so this succeeds for a plain
/// non-admin user with Developer Mode off. Returns the combined mklink
/// stdout/stderr on failure (mklink writes errors to stdout on some Windows
/// builds, stderr on others).
#[cfg(windows)]
fn create_junction(target: &Path, link_path: &Path) -> Result<(), String> {
    let abs_target = lexical_absolute(target);
    let out = Command::new("cmd")
        .args(["/C", "mklink", "/J"])
        .arg(link_path)
        .arg(&abs_target)
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| format!("failed to spawn mklink: {e}"))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        let stdout = String::from_utf8_lossy(&out.stdout);
        let detail = stderr.trim();
        let detail = if detail.is_empty() {
            stdout.trim()
        } else {
            detail
        };
        return Err(format!(
            "mklink /J {link_path:?} → {abs_target:?} failed ({}): {detail}",
            out.status.code().unwrap_or(-1)
        ));
    }
    Ok(())
}

/// Copy the bytes of `target` to `link_path` as a privilege-free substitute for
/// a file symlink. Errors (rather than creating an empty file) when the target
/// does not resolve to an existing file — typically a forward-reference symlink
/// whose target has not been extracted yet — so the caller can fall through to
/// the Developer Mode recovery flow instead of silently shipping a broken link.
#[cfg(windows)]
fn copy_file_fallback(target: &Path, link_path: &Path) -> Result<(), String> {
    let abs_target = lexical_absolute(target);
    if !abs_target.is_file() {
        return Err(format!(
            "target {abs_target:?} is not an existing file (cannot copy)"
        ));
    }
    fs::copy(&abs_target, link_path)
        .map(|_| ())
        .map_err(|e| format!("copy {abs_target:?} → {link_path:?} failed: {e}"))
}

fn has_unsafe_relative_prefix(raw: &str) -> bool {
    raw.starts_with('/')
        || raw.starts_with('\\')
        || raw.starts_with("//")
        || raw.starts_with("\\\\")
        || raw
            .as_bytes()
            .get(0..2)
            .map(|b| b[0].is_ascii_alphabetic() && b[1] == b':')
            .unwrap_or(false)
}

fn normalize_trusted_path(raw: &str) -> Option<String> {
    if raw.is_empty() || raw.contains('\0') {
        return None;
    }

    let normalized = raw.replace('\\', "/");
    let mut prefix = "";
    let mut rest = normalized.as_str();
    let bytes = normalized.as_bytes();

    let drive_prefix = bytes
        .get(0..2)
        .filter(|b| b[0].is_ascii_alphabetic() && b[1] == b':')
        .map(|_| &normalized[..2]);

    if let Some(drive) = drive_prefix {
        prefix = drive;
        rest = &normalized[2..];
        if let Some(stripped) = rest.strip_prefix('/') {
            rest = stripped;
        }
    } else if normalized.starts_with("//") {
        prefix = "//";
        rest = normalized.trim_start_matches('/');
    } else if normalized.starts_with('/') {
        prefix = "/";
        rest = normalized.trim_start_matches('/');
    }

    let mut parts: Vec<&str> = Vec::new();
    for seg in rest.split('/') {
        if seg.is_empty() || seg == "." {
            continue;
        }
        if seg == ".." {
            parts.pop()?;
        } else {
            parts.push(seg);
        }
    }

    Some(match prefix {
        "/" => {
            if parts.is_empty() {
                "/".to_string()
            } else {
                format!("/{}", parts.join("/"))
            }
        }
        "//" => format!("//{}", parts.join("/")),
        "" => parts.join("/"),
        drive => {
            if parts.is_empty() {
                format!("{}/", drive.to_ascii_uppercase())
            } else {
                format!("{}/{}", drive.to_ascii_uppercase(), parts.join("/"))
            }
        }
    })
}

fn is_path_within_root(path: &str, root: &str) -> bool {
    let case_insensitive = root.starts_with("//")
        || root
            .as_bytes()
            .get(0..3)
            .map(|b| b[0].is_ascii_alphabetic() && b[1] == b':' && b[2] == b'/')
            .unwrap_or(false);
    let candidate = if case_insensitive {
        path.to_ascii_lowercase()
    } else {
        path.to_string()
    };
    let base = if case_insensitive {
        root.to_ascii_lowercase()
    } else {
        root.to_string()
    };

    if base.ends_with('/') {
        candidate.starts_with(&base)
    } else {
        candidate == base || candidate.starts_with(&format!("{base}/"))
    }
}

fn normalized_parent(path: &str) -> Option<String> {
    let trimmed = path.trim_end_matches('/');
    let idx = trimmed.rfind('/')?;
    if idx == 0 {
        Some("/".to_string())
    } else if idx == 2 && trimmed.as_bytes().get(1) == Some(&b':') {
        Some(format!("{}/", &trimmed[..2]))
    } else {
        Some(trimmed[..idx].to_string())
    }
}

fn guard_relative_path_under_root(path: &str, root: &str) -> Result<PathBuf, String> {
    if path.is_empty() || path.contains('\0') {
        return Err("Refusing to write outside install root: invalid destination path".to_string());
    }
    if has_unsafe_relative_prefix(path) || path.contains(':') {
        return Err(format!("Refusing to write outside install root: {path:?}"));
    }
    if path
        .replace('\\', "/")
        .split('/')
        .any(|seg| !seg.is_empty() && seg == "..")
    {
        return Err(format!("Refusing to write outside install root: {path:?}"));
    }

    let root = normalize_trusted_path(root)
        .filter(|root| has_unsafe_relative_prefix(root))
        .ok_or_else(|| "Refusing to write because the install root is invalid".to_string())?;
    let relative = normalize_trusted_path(path)
        .filter(|relative| !relative.is_empty())
        .ok_or_else(|| {
            "Refusing to write outside install root: invalid destination path".to_string()
        })?;
    let joined = if root.ends_with('/') {
        format!("{root}{relative}")
    } else {
        format!("{root}/{relative}")
    };
    let destination = normalize_trusted_path(&joined).ok_or_else(|| {
        "Refusing to write outside install root: invalid destination path".to_string()
    })?;

    if !is_path_within_root(&destination, &root) {
        return Err(format!(
            "Refusing to write outside install root: {destination:?}"
        ));
    }

    Ok(PathBuf::from(destination))
}

pub(super) fn guard_absolute_path_under_root(path: &str, root: &str) -> Result<PathBuf, String> {
    let root = normalize_trusted_path(root)
        .filter(|root| has_unsafe_relative_prefix(root))
        .ok_or_else(|| "Refusing to use path because the install root is invalid".to_string())?;
    let destination = normalize_trusted_path(path)
        .filter(|destination| has_unsafe_relative_prefix(destination))
        .ok_or_else(|| "Refusing to use path outside install root: invalid path".to_string())?;

    if !is_path_within_root(&destination, &root) {
        return Err(format!(
            "Refusing to use path outside install root: {destination:?}"
        ));
    }

    Ok(PathBuf::from(destination))
}

fn atomic_write(path: &Path, contents: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "Failed to write file: destination has no parent directory".to_string())?;
    let file_name = path
        .file_name()
        .ok_or_else(|| "Failed to write file: destination has no file name".to_string())?
        .to_string_lossy();
    let temp_path = parent.join(format!(
        ".{file_name}.tmp-{}-{}",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));

    let result = (|| {
        let mut temp_file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp_path)
            .map_err(|e| format!("Failed to create temp file: {e}"))?;
        temp_file
            .write_all(contents)
            .map_err(|e| format!("Failed to write temp file: {e}"))?;
        temp_file
            .sync_all()
            .map_err(|e| format!("Failed to sync temp file: {e}"))?;
        drop(temp_file);
        fs::rename(&temp_path, path).map_err(|e| format!("Failed to replace file: {e}"))
    })();

    if result.is_err() {
        let _ = fs::remove_file(&temp_path);
    }

    result
}

fn relative_segments_under_root(path: &str, root: &str) -> Option<Vec<String>> {
    if path == root {
        return Some(Vec::new());
    }
    let prefix = if root.ends_with('/') {
        root.to_string()
    } else {
        format!("{root}/")
    };
    path.strip_prefix(&prefix).map(|suffix| {
        suffix
            .split('/')
            .filter(|seg| !seg.is_empty())
            .map(ToString::to_string)
            .collect()
    })
}

fn validate_symlink_request(target: &str, link_path: &str, root: &str) -> Result<(), String> {
    if target.is_empty() || target.contains('\0') {
        return Err("Refusing to create symlink with an empty or invalid target".to_string());
    }
    if has_unsafe_relative_prefix(target) || target.contains(':') {
        return Err(format!(
            "Refusing to create symlink with absolute or prefixed target: {target:?}"
        ));
    }

    let normalized_target = target.replace('\\', "/");

    let root = normalize_trusted_path(root).ok_or_else(|| {
        "Refusing to create symlink because the install root is invalid".to_string()
    })?;
    let link_path = normalize_trusted_path(link_path)
        .ok_or_else(|| "Refusing to create symlink because the link path is invalid".to_string())?;
    if !is_path_within_root(&link_path, &root) {
        return Err(format!(
            "Refusing to create symlink outside install root: {link_path:?}"
        ));
    }

    let link_parent = normalized_parent(&link_path)
        .ok_or_else(|| "Refusing to create symlink without a parent path".to_string())?;
    if !is_path_within_root(&link_parent, &root) {
        return Err(format!(
            "Refusing to create symlink whose parent escapes install root: {link_parent:?}"
        ));
    }

    let mut target_segments =
        relative_segments_under_root(&link_parent, &root).ok_or_else(|| {
            "Refusing to create symlink because the parent is outside the install root".to_string()
        })?;

    for seg in normalized_target.split('/') {
        if seg.is_empty() || seg == "." {
            continue;
        }
        if seg == ".." {
            target_segments.pop().ok_or_else(|| {
                format!("Refusing to create symlink target that escapes install root: {target:?}")
            })?;
        } else {
            target_segments.push(seg.to_string());
        }
    }

    Ok(())
}

/// Tauri command: create a symbolic link at `link_path` pointing to `target`.
///
/// Invoked by template-fetcher.ts for tar entries with typeflag '2'. The
/// template ships git symlinks (mode 120000) like `AGENTS.md → .claude/CLAUDE.md`
/// — Tauri's plugin-fs doesn't expose `symlink` from JS, so we route through
/// Rust. The JS extractor validates tar metadata first; this command repeats
/// the target/root check defensively before touching the filesystem.
#[tauri::command]
pub fn create_symlink(target: String, link_path: String, root: String) -> Result<(), String> {
    validate_symlink_request(&target, &link_path, &root)?;
    create_symlink_impl(Path::new(&target), Path::new(&link_path))
}

/// Open the Windows "For developers" settings page (`ms-settings:developers`),
/// where the user toggles Developer Mode — the no-admin way to grant
/// symlink-creation rights. Invoked by the template screen's privilege-recovery
/// flow when even the junction/copy fallback couldn't recover a symlink.
///
/// We shell out to `cmd /C start` rather than the shell plugin's `open`: the
/// plugin's default open-scope validator only permits http(s)/mailto/tel URIs
/// and rejects the `ms-settings:` scheme.
#[cfg(windows)]
#[tauri::command]
pub fn open_developer_settings() -> Result<(), String> {
    // `start` treats its first quoted argument as a window title, so we pass an
    // empty `""` title before the URI to keep the URI from being swallowed.
    Command::new("cmd")
        .args(["/C", "start", "", "ms-settings:developers"])
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("failed to open Developer Mode settings: {e}"))
}

#[cfg(test)]
mod validation_tests {
    use super::*;
    use tempfile::TempDir;

    fn setup() -> TempDir {
        tempfile::tempdir().expect("tmpdir")
    }

    #[test]
    fn write_file_rejects_absolute_destination() {
        let dir = setup();
        let outside = dir.path().join("outside.txt");
        let err = write_file(
            outside.to_string_lossy().to_string(),
            b"nope".to_vec(),
            dir.path().to_string_lossy().to_string(),
            None,
        )
        .expect_err("absolute renderer path must be rejected");

        assert!(err.contains("outside install root"), "got: {err}");
        assert!(!outside.exists());
    }

    #[test]
    fn write_file_rejects_parent_traversal_destination() {
        let dir = setup();
        let outside_name = format!(
            "outside-{}.txt",
            dir.path().file_name().unwrap().to_string_lossy()
        );
        let err = write_file(
            format!("../{outside_name}"),
            b"nope".to_vec(),
            dir.path().to_string_lossy().to_string(),
            None,
        )
        .expect_err("parent traversal must be rejected");

        assert!(err.contains("outside install root"), "got: {err}");
        assert!(!dir.path().parent().unwrap().join(outside_name).exists());
    }

    #[test]
    fn write_file_rejects_destination_that_escapes_root() {
        let dir = setup();
        let outside_name = format!(
            "outside-{}.txt",
            dir.path().file_name().unwrap().to_string_lossy()
        );
        let err = write_file(
            format!("nested/../../{outside_name}"),
            b"nope".to_vec(),
            dir.path().to_string_lossy().to_string(),
            None,
        )
        .expect_err("lexical root escape must be rejected");

        assert!(err.contains("outside install root"), "got: {err}");
        assert!(!dir.path().parent().unwrap().join(outside_name).exists());
    }

    #[test]
    fn write_file_accepts_in_root_destination() {
        let dir = setup();
        write_file(
            "nested/file.txt".to_string(),
            b"hello hq".to_vec(),
            dir.path().to_string_lossy().to_string(),
            None,
        )
        .expect("in-root relative path should write");

        assert_eq!(
            fs::read(dir.path().join("nested/file.txt")).expect("read"),
            b"hello hq"
        );
    }

    #[cfg(unix)]
    #[test]
    fn write_file_preserves_requested_mode() {
        let dir = setup();
        write_file(
            "scripts/run.sh".to_string(),
            b"#!/bin/sh\n".to_vec(),
            dir.path().to_string_lossy().to_string(),
            Some(0o755),
        )
        .expect("in-root file should write");

        let mode = fs::metadata(dir.path().join("scripts/run.sh"))
            .expect("metadata")
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o755);
    }

    #[test]
    fn make_dir_accepts_absolute_path_outside_home_hq_when_under_install_root() {
        let dir = setup();
        let install_root = dir.path().join("Documents").join("HQ");
        let target = install_root.join("nested").join("template");

        make_dir(
            target.to_string_lossy().to_string(),
            install_root.to_string_lossy().to_string(),
        )
        .expect("custom install mkdir should not depend on plugin fs scope");

        assert!(target.is_dir());
    }

    #[test]
    fn make_dir_accepts_relative_path_under_install_root() {
        let dir = setup();
        make_dir(
            "nested/template".to_string(),
            dir.path().to_string_lossy().to_string(),
        )
        .expect("relative in-root mkdir should succeed");

        assert!(dir.path().join("nested/template").is_dir());
    }

    #[test]
    fn make_dir_rejects_parent_traversal_destination() {
        let dir = setup();
        let err = make_dir(
            "../outside-dir".to_string(),
            dir.path().to_string_lossy().to_string(),
        )
        .expect_err("parent traversal must be rejected");

        assert!(err.contains("outside install root"), "got: {err}");
        assert!(!dir.path().parent().unwrap().join("outside-dir").exists());
    }

    #[test]
    fn make_dir_rejects_absolute_path_outside_install_root() {
        let dir = setup();
        let outside = dir.path().parent().unwrap().join("outside-dir");
        let err = make_dir(
            outside.to_string_lossy().to_string(),
            dir.path().to_string_lossy().to_string(),
        )
        .expect_err("absolute out-of-root mkdir must be rejected");

        assert!(err.contains("outside install root"), "got: {err}");
        assert!(!outside.exists());
    }

    #[test]
    fn read_text_file_accepts_absolute_path_outside_home_hq_when_under_install_root() {
        let dir = setup();
        let install_root = dir.path().join("Documents").join("HQ");
        let target = install_root.join(".hq").join("install-manifest.json");
        fs::create_dir_all(target.parent().unwrap()).expect("mkdir");
        fs::write(&target, "{\"ok\":true}").expect("write");

        let raw = read_text_file(
            target.to_string_lossy().to_string(),
            install_root.to_string_lossy().to_string(),
        )
        .expect("custom install read should not depend on plugin fs scope");

        assert_eq!(raw, "{\"ok\":true}");
    }

    #[test]
    fn read_text_file_rejects_absolute_path_outside_install_root() {
        let dir = setup();
        let outside = dir.path().parent().unwrap().join(format!(
            "outside-read-{}.txt",
            dir.path().file_name().unwrap().to_string_lossy()
        ));
        fs::write(&outside, "nope").expect("write outside");

        let err = read_text_file(
            outside.to_string_lossy().to_string(),
            dir.path().to_string_lossy().to_string(),
        )
        .expect_err("absolute out-of-root read must be rejected");

        assert!(err.contains("outside install root"), "got: {err}");
    }

    #[test]
    fn symlink_validation_rejects_absolute_link_path_outside_root() {
        let dir = setup();
        let outside = dir.path().parent().unwrap().join("outside-link");
        let err = validate_symlink_request(
            "inside",
            &outside.to_string_lossy(),
            dir.path().to_str().unwrap(),
        )
        .expect_err("absolute out-of-root link path must be rejected");

        assert!(err.contains("outside install root"), "got: {err}");
    }

    #[test]
    fn symlink_validation_allows_template_parent_links_with_root() {
        validate_symlink_request(
            "../.claude/output-style.md",
            "/tmp/hq/.codex/output-style.md",
            "/tmp/hq",
        )
        .expect("in-root parent traversal should be allowed");

        validate_symlink_request(
            "../../.obsidian",
            "/tmp/hq/companies/_template/.obsidian",
            "/tmp/hq",
        )
        .expect("template links may walk back to the install root");
    }

    #[test]
    fn symlink_validation_rejects_targets_that_escape_root() {
        let err = validate_symlink_request("../.ssh", "/tmp/hq/.ssh", "/tmp/hq")
            .expect_err("root escape must be rejected");
        assert!(err.contains("escapes install root"), "got: {err}");
    }

    #[test]
    fn symlink_validation_rejects_absolute_and_drive_targets() {
        for target in ["/tmp/outside", r"\tmp\outside", r"C:\Users\alice\evil"] {
            let err = validate_symlink_request(target, "/tmp/hq/link", "/tmp/hq")
                .expect_err("absolute target must be rejected");
            assert!(
                err.contains("absolute") || err.contains("prefixed"),
                "got: {err}"
            );
        }
    }

    #[test]
    fn symlink_validation_rejects_link_paths_outside_root() {
        let err = validate_symlink_request("inside", "/tmp/outside/link", "/tmp/hq")
            .expect_err("link path outside root must be rejected");
        assert!(err.contains("outside install root"), "got: {err}");
    }
}

#[cfg(all(test, unix))]
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

#[cfg(all(test, windows))]
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
        // `create_symlink_impl` deliberately rewrites POSIX `/` separators to
        // Windows `\` — a reparse point with `/` in its target LOOKS valid but
        // fails every read (see the rationale comment on `win_target`). The
        // read-back therefore carries backslashes, not the original slash form.
        assert_eq!(target.to_string_lossy(), r".claude\CLAUDE.md");
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

    #[test]
    fn lexical_absolute_collapses_parent_dirs() {
        // `.agents/skills → ../.claude/skills` resolves against the link's
        // parent, producing a `..` segment that mklink must not see.
        let p = Path::new(r"C:\hq\.agents\..\.claude\skills");
        assert_eq!(lexical_absolute(p), PathBuf::from(r"C:\hq\.claude\skills"));
    }

    #[test]
    fn lexical_absolute_preserves_drive_and_root() {
        let p = Path::new(r"C:\a\.\b");
        assert_eq!(lexical_absolute(p), PathBuf::from(r"C:\a\b"));
    }

    #[test]
    fn copy_file_fallback_copies_existing_file() {
        let dir = setup();
        let target = dir.path().join("CLAUDE.md");
        fs::write(&target, b"hello hq").expect("seed target");
        let link = dir.path().join("AGENTS.md");

        copy_file_fallback(&target, &link).expect("copy fallback");

        // It's a real file (not a symlink) carrying the target's bytes.
        let meta = fs::symlink_metadata(&link).expect("stat");
        assert!(meta.file_type().is_file());
        assert_eq!(fs::read(&link).expect("read"), b"hello hq");
    }

    #[test]
    fn copy_file_fallback_errors_on_missing_target() {
        let dir = setup();
        let link = dir.path().join("AGENTS.md");
        // Forward reference: target not extracted yet.
        let err = copy_file_fallback(&dir.path().join("does-not-exist.md"), &link)
            .expect_err("missing target must error");
        assert!(err.contains("not an existing file"), "got: {err}");
        // No empty file left behind.
        assert!(fs::symlink_metadata(&link).is_err());
    }

    #[test]
    fn create_junction_links_directory_readable() {
        // Junctions need no privilege, so this works on any Windows runner
        // regardless of Developer Mode / elevation.
        let dir = setup();
        let target = dir.path().join("skills");
        fs::create_dir(&target).expect("mkdir target");
        fs::write(target.join("a.md"), b"skill").expect("seed file in target");

        let link = dir.path().join("linked-skills");
        create_junction(&target, &link).expect("create junction");

        // Reading THROUGH the junction must surface the target's contents.
        let through = fs::read(link.join("a.md")).expect("read through junction");
        assert_eq!(through, b"skill");
    }
}
